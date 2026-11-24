import { describe, expect, it, vi } from 'vitest'
import { Blocked, checkRobots, politeFetch, runBatch, reusable, type CrawlResult, type FetchText } from './crawl-engine.mts'

const sku = 'LT533R#XW'
const pdp = `<div class="product-detail"><div class="product-column-right"><span class="product-code-location">${sku}</span>
  <div id="main-price-product"><span class="label-price-old">Giá gốc:</span><span class="product-old-price-land">1.000.000đ</span>
  <span class="product-new-price-land">900.000đ</span></div></div></div>
  <script type="application/ld+json">${JSON.stringify({ '@type': 'Product', sku, offers: { price: 900000, priceCurrency: 'VND' } })}</script>`
const search = (code: string) => JSON.stringify({ status: true, products: [{ product_code: code, product_url: '/chau-rua-123.html', product_price: { sku: code, priceOld: '1000000.00', priceNew: '900000.00' } }] })
const fake = (calls: string[]): FetchText => async (url) => { calls.push(url.pathname + url.search); return url.pathname.startsWith('/product/searchProduct') ? search(sku) : pdp }
const T0 = new Date('2026-11-23T10:00:00Z')

describe('#448 crawl engine', () => {
  it('crawls rows, records EXACT prices and the evidence URL/time', async () => {
    const calls: string[] = []
    const run = await runBatch({ rows: [{ id: 1, sku, is_active: true }], fetchText: fake(calls), now: () => T0 })
    expect(run).toMatchObject({ crawled: 1, reused: 0, haltReason: null, remaining: 0 })
    expect(run.results[0]).toMatchObject({ status: 'EXACT', regular_price_vnd: 1_000_000, promotional_price_vnd: 900_000, retrieved_at_utc: T0.toISOString(), source_url: 'https://hita.com.vn/chau-rua-123.html' })
  })
  it('resume: a fresh terminal result is reused without any request; stale or UNKNOWN is crawled again', async () => {
    const calls: string[] = []
    const base = { dpg_id: 1, dpg_sku: sku, category: 'thiet-bi-ve-sinh', is_active: true, exception: null, source_url: 'x', regular_price_vnd: 1, promotional_price_vnd: null, online_voucher_amount_vnd: null, hita_exact_sku: sku, online_voucher_condition: null, search_candidates: [], evidence: null } as const
    const fresh: CrawlResult = { ...base, status: 'EXACT', retrieved_at_utc: new Date(T0.getTime() - 3600_000).toISOString() }
    const stale: CrawlResult = { ...fresh, retrieved_at_utc: new Date(T0.getTime() - 48 * 3600_000).toISOString() }
    const unknown: CrawlResult = { ...fresh, status: 'UNKNOWN' }
    const rows = [{ id: 1, sku, is_active: true }]
    expect((await runBatch({ rows, fetchText: fake(calls), previous: new Map([[1, fresh]]), now: () => T0 })).reused).toBe(1)
    expect(calls).toHaveLength(0)
    for (const prior of [stale, unknown]) expect((await runBatch({ rows, fetchText: fake(calls), previous: new Map([[1, prior]]), now: () => T0 })).crawled).toBe(1)
    expect(reusable({ ...fresh, retrieved_at_utc: new Date(T0.getTime() + 60_000).toISOString() }, 3600_000, T0)).toBe(false)
    expect(reusable({ ...fresh, status: 'BLOCKED' }, 3600_000, T0)).toBe(false)
  })
  it('a block stops the whole run immediately: no further request is made and no result is invented', async () => {
    let n = 0
    const fetchText: FetchText = async () => { n++; throw new Blocked('HTTP_429_OR_CHALLENGE') }
    const run = await runBatch({ rows: [{ id: 1, sku: 'A', is_active: true }, { id: 2, sku: 'B', is_active: true }, { id: 3, sku: 'C', is_active: true }], fetchText })
    expect(n).toBe(1)
    expect(run).toMatchObject({ haltReason: 'HTTP_429_OR_CHALLENGE', crawled: 0, remaining: 3, results: [] })
  })
  it('a non-block technical error becomes UNKNOWN for that SKU only and the batch continues', async () => {
    const fetchText: FetchText = async (url) => { if (url.searchParams.get('key') === 'BAD') throw new Error('INVALID_SEARCH'); return url.pathname.startsWith('/product/searchProduct') ? search(sku) : pdp }
    const run = await runBatch({ rows: [{ id: 1, sku: 'BAD', is_active: true }, { id: 2, sku, is_active: true }], fetchText })
    expect(run.results.map(r => r.status)).toEqual(['UNKNOWN', 'EXACT'])
  })
  it('honours --limit and reports what is left', async () => {
    const run = await runBatch({ rows: [{ id: 1, sku, is_active: true }, { id: 2, sku: 'X', is_active: true }], fetchText: fake([]), limit: 1 })
    expect(run).toMatchObject({ crawled: 1, haltReason: 'LIMIT_REACHED', remaining: 1 })
  })
  it('an exact SKU that Hita does not list is NOT_FOUND (no sibling price)', async () => {
    const fetchText: FetchText = async () => JSON.stringify({ status: false, products: [] })
    const run = await runBatch({ rows: [{ id: 1, sku: 'ZZZ', is_active: true }], fetchText })
    expect(run.results[0]).toMatchObject({ status: 'NOT_FOUND', regular_price_vnd: null, promotional_price_vnd: null, online_voucher_amount_vnd: null })
  })
})

describe('#448 polite fetch', () => {
  const resp = (status: number, headers: Record<string, string> = {}, body = '{}') => new Response(body, { status, headers })
  it('treats 403/429/503 and Cloudflare challenges as Blocked and never retries them', async () => {
    for (const r of [() => resp(403), () => resp(429), () => resp(503), () => resp(200, { 'cf-mitigated': 'challenge', 'content-type': 'application/json' })]) {
      const impl = vi.fn(async () => r())
      await expect(politeFetch({ minIntervalMs: 0, fetchImpl: impl as unknown as typeof fetch })(new URL('https://hita.com.vn/x'), 'application/json')).rejects.toBeInstanceOf(Blocked)
      expect(impl).toHaveBeenCalledTimes(1)
    }
  })
  it('detects a challenge page served with 200 and HTML returned for a JSON search', async () => {
    const page = vi.fn(async () => resp(200, { 'content-type': 'text/html' }, '<title>Just a moment...</title>'))
    await expect(politeFetch({ minIntervalMs: 0, fetchImpl: page as unknown as typeof fetch })(new URL('https://hita.com.vn/a-1.html'), 'text/html')).rejects.toThrow('ACCESS_CHALLENGE')
    const html = vi.fn(async () => resp(200, { 'content-type': 'text/html' }, '<html></html>'))
    await expect(politeFetch({ minIntervalMs: 0, fetchImpl: html as unknown as typeof fetch })(new URL('https://hita.com.vn/product/searchProduct?key=a'), 'application/json')).rejects.toThrow('HTML_INSTEAD_OF_SEARCH_JSON')
  })
  it('identifies itself honestly and keeps the minimum interval between requests', async () => {
    const stamps: number[] = [], agents: string[] = []
    const impl = (async (_: unknown, init: RequestInit) => { stamps.push(Date.now()); agents.push(String((init.headers as Record<string, string>)['User-Agent'])); return resp(200, { 'content-type': 'application/json' }) }) as unknown as typeof fetch
    const f = politeFetch({ minIntervalMs: 120, fetchImpl: impl })
    await f(new URL('https://hita.com.vn/a'), 'application/json'); await f(new URL('https://hita.com.vn/b'), 'application/json')
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(110)
    expect(agents[0]).toMatch(/^DongPhuGia-price-audit\//)
  })
  it('retries a 5xx once, then surfaces the failure as a normal error (not a block)', async () => {
    const impl = vi.fn(async () => resp(500, { 'content-type': 'text/html' }))
    await expect(politeFetch({ minIntervalMs: 0, fetchImpl: impl as unknown as typeof fetch })(new URL('https://hita.com.vn/x'), 'text/html')).rejects.not.toBeInstanceOf(Blocked)
    expect(impl).toHaveBeenCalledTimes(2)
  })
})

describe('#448 robots gate', () => {
  it('passes an empty/allow-all robots.txt, stops on a restriction or a block', async () => {
    expect(await checkRobots(async () => 'User-agent: *\nDisallow:\n')).toBeNull()
    expect(await checkRobots(async () => 'User-agent: *\nDisallow: /product/\n')).toBe('ROBOTS_POLICY_REVIEW_REQUIRED')
    expect(await checkRobots(async () => 'Crawl-delay: 10\n')).toBe('ROBOTS_POLICY_REVIEW_REQUIRED')
    expect(await checkRobots(async () => { throw new Blocked('HTTP_403_OR_CHALLENGE') })).toBe('HTTP_403_OR_CHALLENGE')
  })
})

describe('#477 recovery', () => {
  it('reuses a verified single-price PDP in one request and ignores a previous parser checkpoint', async () => {
    const onePrice = pdp.replace('1.000.000đ', '').replace('</script>', '</script><table><tr><td id="brand-product">INAX</td></tr></table>')
    const row = { id: 11, sku, is_active: true, brand: 'INAX', pdp_url: 'https://hita.com.vn/chau-rua-123.html' }
    const fetchText = vi.fn(async () => onePrice)
    const first = await runBatch({ rows: [row], fetchText, now: () => T0 })
    expect(first.results[0]).toMatchObject({ status: 'EXACT', regular_price_vnd: 900_000, promotional_price_vnd: null })
    expect(fetchText).toHaveBeenCalledTimes(1)
    const previous = new Map([[row.id, { ...first.results[0], parser_version: 'old' }]])
    expect((await runBatch({ rows: [row], fetchText, previous, now: () => T0 })).crawled).toBe(1)
    expect((await runBatch({ rows: [row], fetchText, previous: new Map([[row.id, first.results[0]]]), now: () => T0 })).reused).toBe(1)
    expect(fetchText).toHaveBeenCalledTimes(2)
  })

  it('stops at the request budget before making an additional request', async () => {
    const fetchImpl = vi.fn(async () => new Response('User-agent: *', { headers: { 'content-type': 'text/plain' } }))
    const fetchText = politeFetch({ requestBudget: 1, fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await checkRobots(fetchText)).toBeNull()
    await expect(fetchText(new URL('https://hita.com.vn/robots.txt'), 'text/plain')).rejects.toThrow('REQUEST_BUDGET_REACHED')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
