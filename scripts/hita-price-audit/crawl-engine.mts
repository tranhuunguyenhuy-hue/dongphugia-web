import { setTimeout as sleepFor } from 'node:timers/promises'
import { findProduct, parserVersion, parsePdp, pdpUrl, searchUrl } from './adapter.mts'
import type { InventoryRow } from './batch-plan.mts'

// #448 batch crawl engine. Network access is injected (`fetchText`) so checkpoint/resume/stop rules are testable offline.
// A block (HTTP 401/403/429/503, Cloudflare challenge, challenge page) STOPS the run: it is never retried around.
export class Blocked extends Error {}
export class Retryable extends Error {}
export type FetchText = (url: URL, accept: 'application/json' | 'text/html' | 'text/plain') => Promise<string>

export type CrawlResult = {
  dpg_id: number; dpg_sku: string; category: 'thiet-bi-ve-sinh'; is_active: boolean
  status: string; exception: string | null; source_url: string; retrieved_at_utc: string | null
  regular_price_vnd: number | null; promotional_price_vnd: number | null; online_voucher_amount_vnd: number | null
  hita_exact_sku: string | null; online_voucher_condition: string | null; search_candidates: string[]
  evidence: unknown; parser_version?: string; expected_brand?: string
}
export const TERMINAL = new Set(['EXACT', 'CONTACT', 'DISCONTINUED', 'NOT_FOUND', 'AMBIGUOUS'])

export async function crawlOne(row: InventoryRow, fetchText: FetchText, now: () => Date = () => new Date()): Promise<CrawlResult> {
  const base = { dpg_id: row.id, dpg_sku: row.sku, category: 'thiet-bi-ve-sinh' as const, is_active: row.is_active, parser_version: parserVersion, expected_brand: row.brand }
  const empty = { regular_price_vnd: null, promotional_price_vnd: null, online_voucher_amount_vnd: null, hita_exact_sku: null, evidence: null as unknown }
  let source = searchUrl(row.sku).href, candidates: string[] = [], touched = false
  let preferredPage: { url: string; html: string } | undefined
  try {
    touched = true
    if (row.pdp_url && row.brand) {
      try {
        const url = pdpUrl(row.pdp_url)
        preferredPage = { url: url.href, html: await fetchText(url, 'text/html') }
        const parsed = parsePdp(preferredPage.html, row.sku, undefined, row.brand)
        // Only reuse a known PDP for a clear single-price result, independently corroborated by its exact offer.
        // Search still corroborates promotions, stock outcomes and anything unresolved.
        if (parsed.status === 'EXACT' && parsed.promotional_price_vnd === null &&
            parsed.online_voucher_amount_vnd === null && !parsed.exception) {
          return { ...base, ...parsed, source_url: url.href, retrieved_at_utc: now().toISOString(),
            online_voucher_condition: null, search_candidates: [] }
        }
      } catch (error) {
        if (error instanceof Blocked) throw error
      }
    }
    const discover = async (query: string) => findProduct(JSON.parse(await fetchText(searchUrl(query), 'application/json')), row.sku)
    let found = await discover(row.sku)
    if (row.brand && found.hits.length === 0) {
      // Adjust presentation only for discovery. Both the search result and the PDP must still match the original SKU.
      const alternate = row.sku.replace(/\s*([/+])\s*/g, ' $1 ').replace(/\s+/g, ' ').trim()
      if (alternate !== row.sku) {
        const fallback = await discover(alternate)
        found = { hits: fallback.hits, candidates: [...new Set([...found.candidates, ...fallback.candidates])] }
      }
    }
    candidates = found.candidates
    const hit = found.hits[0]
    if (found.hits.length > 1) return { ...base, ...empty, status: 'AMBIGUOUS', exception: 'DUPLICATE_EXACT_SEARCH_HITS', source_url: source, retrieved_at_utc: now().toISOString(), online_voucher_condition: null, search_candidates: candidates }
    if (!hit) return { ...base, ...empty, status: candidates.length ? 'AMBIGUOUS' : 'NOT_FOUND', exception: 'NO_EXACT_SEARCH_HIT', source_url: source, retrieved_at_utc: now().toISOString(), online_voucher_condition: null, search_candidates: candidates }
    if (!hit.product_url) throw new Error('MISSING_PDP_URL')
    const url = pdpUrl(hit.product_url)
    source = url.href
    const html = preferredPage?.url === url.href ? preferredPage.html : await fetchText(url, 'text/html')
    const parsed = parsePdp(html, row.sku, hit, row.brand)
    return { ...base, ...parsed, source_url: source, retrieved_at_utc: now().toISOString(), online_voucher_condition: parsed.evidence?.voucher_condition || null, search_candidates: candidates }
  } catch (error) {
    if (error instanceof Blocked) throw error
    return { ...base, ...empty, status: 'UNKNOWN', exception: error instanceof Error ? error.message.slice(0, 80) : 'REQUEST_FAILED', source_url: source,
      retrieved_at_utc: touched ? now().toISOString() : null, online_voucher_condition: null, search_candidates: candidates }
  }
}

// robots.txt gate (same rule as the #450 pilot): a block, or any non-empty Disallow/Crawl-delay, stops the run for review.
export async function checkRobots(fetchText: FetchText): Promise<string | null> {
  try {
    const robots = await fetchText(new URL('https://hita.com.vn/robots.txt'), 'text/plain')
    return /^\s*(?:Disallow|Crawl-delay)\s*:\s*[^\s#]/im.test(robots) ? 'ROBOTS_POLICY_REVIEW_REQUIRED' : null
  } catch (error) {
    return error instanceof Error ? error.message : 'ROBOTS_UNAVAILABLE'
  }
}

// Reuse rule on resume: a TERMINAL result younger than the TTL is kept; BLOCKED/UNKNOWN or stale results are crawled again.
export function reusable(previous: CrawlResult | undefined, ttlMs: number, now: Date) {
  if (!previous || !TERMINAL.has(previous.status) || !previous.retrieved_at_utc) return false
  const age = now.getTime() - Date.parse(previous.retrieved_at_utc)
  return Number.isFinite(age) && age >= 0 && age <= ttlMs
}

export type BatchOptions = {
  rows: InventoryRow[]; fetchText: FetchText; previous?: Map<number, CrawlResult>; ttlMs?: number
  now?: () => Date; limit?: number; onResult?: (result: CrawlResult, reused: boolean) => Promise<void> | void
}
export async function runBatch(options: BatchOptions) {
  const { rows, fetchText, previous = new Map(), ttlMs = 6 * 3600_000, now = () => new Date(), limit = Infinity, onResult } = options
  const results: CrawlResult[] = []
  let crawled = 0, reused = 0, haltReason: string | null = null
  for (const row of rows) {
    const old = previous.get(row.id)
    if (old && old.dpg_sku === row.sku && old.is_active === row.is_active &&
        (!row.brand || old.parser_version === parserVersion && old.expected_brand === row.brand) && reusable(old, ttlMs, now())) { results.push(old); reused++; await onResult?.(old, true); continue }
    if (crawled >= limit) { haltReason = 'LIMIT_REACHED'; break }
    try {
      const result = await crawlOne(row, fetchText, now)
      results.push(result); crawled++
      await onResult?.(result, false)
    } catch (error) {
      if (error instanceof Blocked) { haltReason = error.message; break }
      throw error
    }
  }
  return { results, crawled, reused, haltReason, remaining: rows.length - results.length }
}

// Polite network layer: >= minIntervalMs between requests, bounded size/time, 2 attempts only for 5xx/timeouts.
export function politeFetch({ minIntervalMs = 1000, requestBudget = Infinity, userAgent = 'DongPhuGia-price-audit/1.0', fetchImpl = fetch as typeof fetch, log = (entry: { url: string; status: number | null; ms: number }) => { void entry } } = {}): FetchText {
  let last = 0
  let requests = 0
  return async (url, accept) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (requests >= requestBudget) throw new Blocked('REQUEST_BUDGET_REACHED')
      const wait = last + (attempt ? 2000 : minIntervalMs) - Date.now()
      if (wait > 0) await sleepFor(wait)
      last = Date.now()
      requests++
      const start = performance.now()
      let status: number | null = null
      try {
        const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { Accept: accept, 'User-Agent': userAgent } })
        status = response.status
        if ([401, 403, 429, 503].includes(status) || response.headers.get('cf-mitigated') === 'challenge') { await response.body?.cancel(); throw new Blocked(`HTTP_${status}_OR_CHALLENGE`) }
        const contentType = response.headers.get('content-type') ?? ''
        if (response.ok && accept === 'application/json' && contentType.includes('text/html')) { await response.body?.cancel(); throw new Blocked('HTML_INSTEAD_OF_SEARCH_JSON') }
        if (!response.ok || !contentType.includes(accept)) { await response.body?.cancel(); if (status >= 500) throw new Retryable(`HTTP_${status}`); throw new Error(`UNEXPECTED_RESPONSE_${status}`) }
        const body = await response.text()
        if (body.length > 5_000_000) throw new Error('RESPONSE_TOO_LARGE')
        if (/<title>\s*(?:Just a moment|Attention Required|Access Denied)/i.test(body)) throw new Blocked('ACCESS_CHALLENGE')
        return body
      } catch (error) {
        const transient = error instanceof Retryable || error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
        if (!transient || attempt) throw error
      } finally { log({ url: url.pathname, status, ms: Math.round(performance.now() - start) }) }
    }
    throw new Error('REQUEST_FAILED')
  }
}
