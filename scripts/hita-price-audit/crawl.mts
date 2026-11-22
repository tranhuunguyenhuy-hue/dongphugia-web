import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { category, findProduct, parsePdp, pdpUrl, searchUrl, skuKey } from './adapter.mts'

const legacyFields = ['price', 'original_price', 'list_price', 'sale_price', 'online_discount_amount'] as const
type Legacy = Record<typeof legacyFields[number], string | null>
type Input = Legacy & { id: number; sku: string; category: string; pdp_url?: string }
type Parsed = Omit<ReturnType<typeof parsePdp>, 'evidence'> & { evidence: ReturnType<typeof parsePdp>['evidence'] | null }
type Row = Parsed & {
  dpg_id: number
  dpg_sku: string
  category: string
  source_url: string
  retrieved_at_utc: string | null
  online_voucher_condition: string | null
  search_candidates: string[]
  legacy: Record<string, string | null>
  selling_delta_vs_legacy_price_vnd: number | null
  voucher_delta_vs_legacy_online_vnd: number | null
  proposed_only: true
  source_policy: 'HITA_RESEARCH_ONLY'
}
class Blocked extends Error {}
class Retryable extends Error {}

const { values } = parseArgs({ options: {
  input: { type: 'string', default: 'scripts/hita-price-audit/sample/allowlist.json' },
  output: { type: 'string', default: 'hita-audit-output' },
  limit: { type: 'string', default: '20' },
  'dry-run': { type: 'boolean', default: true },
} })
const limit = Number(values.limit)
if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('--limit must be an integer from 1 to 20')
const input: Input[] = JSON.parse(await readFile(values.input, 'utf8'))
if (!Array.isArray(input) || input.length < 1 || input.length > 20 ||
    input.some(row => row.category !== category || !Number.isSafeInteger(row.id) || row.id < 1 ||
      typeof row.sku !== 'string' || !row.sku.trim() || row.sku.length > 120 ||
      legacyFields.some(key => row[key] !== null && (typeof row[key] !== 'string' || !/^-?\d+(?:\.\d{1,2})?$/.test(row[key])))) ||
    new Set(input.map(row => skuKey(row.sku))).size !== input.length ||
    new Set(input.map(row => row.id)).size !== input.length) {
  throw new Error('Expected 1–20 unique DPG IDs and SKUs in the sanitary catalogue with legacy price evidence')
}
input.forEach(row => { if (row.pdp_url) pdpUrl(row.pdp_url) })

const requests: { url: string; status: number | null; duration_ms: number }[] = []
async function request(url: URL, accept: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (requests.length) await sleep(attempt ? 2000 : 1000)
    const start = performance.now()
    let status: number | null = null
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Accept: accept } })
      status = response.status
      if ([401, 403, 429, 503].includes(status) || response.headers.get('cf-mitigated') === 'challenge') {
        await response.body?.cancel()
        throw new Blocked(`HTTP_${status}_OR_CHALLENGE`)
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (response.ok && accept === 'application/json' && contentType.includes('text/html')) {
        await response.body?.cancel()
        throw new Blocked('HTML_INSTEAD_OF_SEARCH_JSON')
      }
      if (!response.ok || !contentType.includes(accept)) {
        await response.body?.cancel()
        if (status >= 500) throw new Retryable(`HTTP_${status}`)
        throw new Error(`UNEXPECTED_RESPONSE_${status}`)
      }
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let bytes = 0
      let body = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.length
          if (bytes > 5_000_000) throw new Error('RESPONSE_TOO_LARGE')
          body += decoder.decode(value, { stream: true })
        }
      } finally {
        await reader.cancel()
      }
      // Restrict body challenge detection to the HTML title, away from unrelated scripts.
      if (/<title>\s*(?:Just a moment|Attention Required|Access Denied)/i.test(body)) throw new Blocked('ACCESS_CHALLENGE')
      return body + decoder.decode()
    } catch (error) {
      const transient = error instanceof Retryable || error instanceof TypeError ||
        (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
      if (!transient || attempt) throw error
    } finally {
      requests.push({ url: url.href, status, duration_ms: Math.round(performance.now() - start) })
    }
  }
  throw new Error('REQUEST_FAILED')
}

const startedAt = new Date().toISOString()
let stop: string | null = null
try {
  const robots = await request(new URL('https://hita.com.vn/robots.txt'), 'text/plain')
  // Pilot only: stop for review if Hita adds a nonempty robots restriction.
  if (/^\s*(?:Disallow|Crawl-delay)\s*:\s*[^\s#]/im.test(robots)) stop = 'ROBOTS_POLICY_REVIEW_REQUIRED'
} catch (error) {
  stop = error instanceof Error ? error.message : 'ROBOTS_UNAVAILABLE'
}

const rows: Row[] = []
for (const row of input.slice(0, limit)) {
  const lookup = searchUrl(row.sku)
  let source = lookup.href
  let candidates: string[] = []
  const requestCount = requests.length
  let parsed: Parsed = {
    status: 'UNKNOWN', exception: null, regular_price_vnd: null, promotional_price_vnd: null,
    online_voucher_amount_vnd: null, hita_exact_sku: null, evidence: null,
  }
  try {
    if (stop) throw new Blocked(stop)
    const found = findProduct(JSON.parse(await request(lookup, 'application/json')), row.sku)
    candidates = found.candidates
    const hit = found.hits[0]
    if (found.hits.length > 1) {
      parsed = { ...parsed, status: 'AMBIGUOUS', exception: 'DUPLICATE_EXACT_SEARCH_HITS' }
    } else if (!hit && !row.pdp_url) {
      parsed = { ...parsed, status: candidates.length ? 'AMBIGUOUS' : 'NOT_FOUND', exception: 'NO_EXACT_SEARCH_HIT' }
    } else {
      const verified = row.pdp_url ? pdpUrl(row.pdp_url) : null
      const foundUrl = hit?.product_url ? pdpUrl(hit.product_url) : null
      if (verified && foundUrl && verified.href !== foundUrl.href) throw new Error('PDP_URL_CONFLICT')
      const url = verified ?? foundUrl
      if (!url) throw new Error('MISSING_PDP_URL')
      source = url.href
      parsed = parsePdp(await request(url, 'text/html'), row.sku, hit)
    }
  } catch (error) {
    if (error instanceof Blocked) stop = error.message
    parsed = { ...parsed, status: stop ? 'BLOCKED' : 'UNKNOWN', exception: error instanceof Error ? error.message : 'REQUEST_FAILED' }
  }
  const legacy = Object.fromEntries(legacyFields.map(key => [key, row[key]]))
  const selling = parsed.promotional_price_vnd ?? parsed.regular_price_vnd
  rows.push({
    dpg_id: row.id, dpg_sku: row.sku, category: row.category, source_url: source,
    retrieved_at_utc: requests.length > requestCount ? new Date().toISOString() : null,
    ...parsed, online_voucher_condition: parsed.evidence?.voucher_condition || null, search_candidates: candidates, legacy,
    selling_delta_vs_legacy_price_vnd: selling !== null && Number(row.price) > 0 ? selling - Number(row.price) : null,
    voucher_delta_vs_legacy_online_vnd: parsed.online_voucher_amount_vnd !== null && Number(row.online_discount_amount) > 0
      ? parsed.online_voucher_amount_vnd - Number(row.online_discount_amount) : null,
    proposed_only: true, source_policy: 'HITA_RESEARCH_ONLY',
  })
}
const summary = {
  started_at_utc: startedAt, completed_at_utc: new Date().toISOString(), requested: rows.length,
  by_status: Object.fromEntries(['EXACT', 'AMBIGUOUS', 'NOT_FOUND', 'CONTACT', 'DISCONTINUED', 'BLOCKED', 'UNKNOWN']
    .map(status => [status, rows.filter(row => row.status === status).length])),
  with_three_prices: rows.filter(row => row.promotional_price_vnd !== null && row.online_voucher_amount_vnd !== null).length,
  with_regular_and_promotional: rows.filter(row => row.promotional_price_vnd !== null).length,
  without_price_candidate: rows.filter(row => row.regular_price_vnd === null).length,
  selling_changed_vs_legacy: rows.filter(row => row.selling_delta_vs_legacy_price_vnd !== null && row.selling_delta_vs_legacy_price_vnd !== 0).length,
  halt_reason: stop,
}
const keys = Object.keys(rows[0]) as Array<keyof typeof rows[number]>
const cell = (value: unknown) => {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (typeof value === 'string' && /^[\s\uFEFF]*[=+@-]/.test(value)) text = "'" + text
  return '"' + text.replaceAll('"', '""') + '"'
}
await mkdir(values.output, { recursive: true })
await writeFile(join(values.output, 'prices.json'), JSON.stringify({ summary, requests, rows }, null, 2) + '\n')
await writeFile(join(values.output, 'prices.csv'), [keys.join(','), ...rows.map(row => keys.map(key => cell(row[key])).join(','))].join('\n') + '\n')
console.log(JSON.stringify(summary, null, 2))
if (stop || summary.by_status.UNKNOWN) process.exitCode = 1
