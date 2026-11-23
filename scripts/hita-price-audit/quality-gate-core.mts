// #466-A CSV Quality Gate. Pure functions, no network, no DB. Reuses the column contract of the #448/#462/#465 CSVs.
// FAIL = hard error (the row can never be used). WARN = needs an Owner look (never auto-excluded by an arbitrary threshold).
export type Severity = 'FAIL' | 'WARN'
export type Issue = { line: number; dpg_id: string; sku: string; severity: Severity; code: string; detail: string }
export type Klass = 'ELIGIBLE_PRICED' | 'ELIGIBLE_NO_PRICE' | 'UNRESOLVED' | 'INVALID'
export type InvRow = { id: number; sku: string; is_active: boolean }

export const REQUIRED_COLUMNS = ['dpg_id', 'sku', 'is_active', 'hita_exact_sku', 'hita_url', 'regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd',
  'currency', 'source_checked_at_utc', 'price_valid_until', 'voucher_condition', 'status', 'review_status'] as const
const STATUSES = new Set(['EXACT', 'CONTACT', 'DISCONTINUED', 'NOT_FOUND', 'AMBIGUOUS', 'BLOCKED', 'UNKNOWN', 'NOT_CRAWLED'])
const NO_PRICE_OUTCOMES = new Set(['CONTACT', 'DISCONTINUED', 'NOT_FOUND', 'AMBIGUOUS'])
const UNRESOLVED_STATUSES = new Set(['BLOCKED', 'UNKNOWN', 'NOT_CRAWLED'])
const FRESH = new Set(['FRESH_CRAWL_PENDING_OWNER_REVIEW'])
const KNOWN_REVIEW = (v: string) => FRESH.has(v) || v === 'NOT_CHECKED' || v === 'NOT_CRAWLED_PENDING' || v === 'BLOCKED_NOT_NO_PRICE' || v === 'UNKNOWN_TECHNICAL' || /^STALE_PILOT/.test(v)
const PDP_URL = /^https:\/\/hita\.com\.vn\/[a-z0-9-]+-\d+\.html$/

// RFC 4180 parser: BOM, CRLF/LF, quoted fields with "" escapes and embedded newlines.
export function parseCsv(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = [], field = '', quoted = false, i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  for (; i < text.length; i++) {
    const c = text[i]
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false } else field += c }
    else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; if (row.length > 1 || row[0] !== '') out.push(row); row = [] }
    else field += c
  }
  if (field !== '' || row.length) { row.push(field); out.push(row) }
  return out
}

const positiveInt = (v: string) => (/^[1-9]\d{0,11}$/.test(v) ? Number(v) : null)
export type Options = { now: Date; maxAgeHours?: number; inventory?: Map<number, InvRow> }

export function validate(csvText: string, opts: Options) {
  const issues: Issue[] = []
  const table = parseCsv(csvText)
  const header = (table[0] ?? []).map(h => h.trim())
  const missing = REQUIRED_COLUMNS.filter(c => !header.includes(c))
  const fileIssues: string[] = [...missing.map(c => `MISSING_COLUMN:${c}`), ...(new Set(header).size !== header.length ? ['DUPLICATE_COLUMN'] : [])]
  const rows = table.slice(1).map(cells => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])))
  const klass: Klass[] = []
  if (fileIssues.length) return { fileIssues, issues, rows: rows.length, klass, header }
  const maxAgeMs = (opts.maxAgeHours ?? 24) * 3600_000
  const seenId = new Map<string, number>(), seenSku = new Map<string, number>(), urlUse = new Map<string, number[]>()
  rows.forEach((r, idx) => {
    const line = idx + 2, add = (severity: Severity, code: string, detail: string) => issues.push({ line, dpg_id: r.dpg_id, sku: r.sku, severity, code, detail })
    const fail = (code: string, detail = '') => add('FAIL', code, detail), warn = (code: string, detail = '') => add('WARN', code, detail)
    const before = issues.length
    const id = /^[1-9]\d*$/.test(r.dpg_id) ? Number(r.dpg_id) : null
    if (id === null) fail('DPG_ID_INVALID', r.dpg_id)
    else if (seenId.has(r.dpg_id)) fail('DPG_ID_DUPLICATE', `first at line ${seenId.get(r.dpg_id)}`); else seenId.set(r.dpg_id, line)
    const skuKey = r.sku.trim().toUpperCase()
    if (!r.sku.trim()) fail('SKU_BLANK')
    else {
      if (r.sku !== r.sku.trim()) fail('SKU_WHITESPACE')
      if (seenSku.has(skuKey)) fail('SKU_DUPLICATE', `first at line ${seenSku.get(skuKey)}`); else seenSku.set(skuKey, line)
    }
    if (!['true', 'false'].includes(r.is_active)) fail('IS_ACTIVE_INVALID', r.is_active)
    if (!STATUSES.has(r.status)) fail('STATUS_UNKNOWN', r.status)
    if (!KNOWN_REVIEW(r.review_status)) fail('REVIEW_STATUS_UNKNOWN', r.review_status)
    for (const [k, v] of Object.entries(r)) if (/^[\t\r]*[=+\-@]/.test(v) && !/_vnd$/.test(k) && k !== 'source_checked_at_utc' && k !== 'price_valid_until') fail('FORMULA_CELL', k)
    if (opts.inventory && id !== null) {
      const inv = opts.inventory.get(id)
      if (!inv) fail('INVENTORY_ID_NOT_FOUND'); else {
        if (inv.sku !== r.sku) fail('INVENTORY_SKU_MISMATCH', 'DPG sku differs from inventory')
        if (String(inv.is_active) !== r.is_active) fail('INVENTORY_ACTIVE_MISMATCH', `${inv.is_active} vs ${r.is_active}`)
      }
    }
    const prices = { regular: r.regular_price_vnd, promo: r.promotional_price_vnd, voucher: r.online_voucher_amount_vnd }
    const anyPrice = Object.values(prices).some(v => v !== '')
    if (r.status !== 'EXACT') {
      if (anyPrice) fail('PRICE_ON_NON_EXACT', r.status)       // blank != 0: a non-priced outcome must carry no price at all
    } else {
      const n = { regular: positiveInt(prices.regular), promo: prices.promo === '' ? null : positiveInt(prices.promo), voucher: prices.voucher === '' ? null : positiveInt(prices.voucher) }
      if (prices.regular === '') fail('REGULAR_MISSING')
      for (const [name, v] of Object.entries(prices)) if (v !== '' && positiveInt(v) === null) fail('PRICE_FORMAT', `${name}=${v.length > 20 ? 'long' : v}`)
      if (n.regular && n.promo && n.promo >= n.regular) fail('PROMO_NOT_BELOW_REGULAR')
      const selling = n.promo ?? n.regular
      if (n.voucher && selling && n.voucher >= selling) fail('VOUCHER_NOT_BELOW_SELLING')
      if (n.voucher && !r.voucher_condition.trim()) fail('VOUCHER_WITHOUT_CONDITION')
      else if (n.voucher && !/online/i.test(r.voucher_condition)) warn('VOUCHER_CONDITION_NOT_ONLINE', r.voucher_condition.slice(0, 60))
      if (!r.hita_exact_sku.trim()) fail('HITA_SKU_MISSING')
      else if (r.hita_exact_sku.trim().toUpperCase() !== skuKey) fail('HITA_SKU_MISMATCH', `${r.hita_exact_sku} vs ${r.sku}`)
      else if (r.hita_exact_sku !== r.sku) warn('SKU_CASE_DIFF', `${r.hita_exact_sku} vs ${r.sku}`)
      if (!PDP_URL.test(r.hita_url)) fail('HITA_URL_INVALID', r.hita_url.slice(0, 80)); else urlUse.set(r.hita_url, [...(urlUse.get(r.hita_url) ?? []), line])
      if (r.currency !== 'VND') fail('CURRENCY_NOT_VND', r.currency)
      const checked = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(r.source_checked_at_utc) ? Date.parse(r.source_checked_at_utc) : NaN
      if (!Number.isFinite(checked)) fail('CHECKED_AT_INVALID', r.source_checked_at_utc)
      else if (checked > opts.now.getTime() + 60_000) fail('CHECKED_AT_IN_FUTURE', r.source_checked_at_utc)
      else if (opts.now.getTime() - checked > maxAgeMs) warn('CHECKED_STALE', `older than ${opts.maxAgeHours ?? 24}h`)
      if (!r.price_valid_until) warn('VALID_UNTIL_MISSING')
      else if (!/^\d{4}-\d{2}-\d{2}/.test(r.price_valid_until) || !Number.isFinite(Date.parse(r.price_valid_until))) warn('VALID_UNTIL_INVALID', r.price_valid_until)
      else { const until = Date.parse(r.price_valid_until.length === 10 ? r.price_valid_until + 'T23:59:59Z' : r.price_valid_until)
        if (until < opts.now.getTime()) warn('VALID_UNTIL_EXPIRED', r.price_valid_until); else if (until - opts.now.getTime() < 48 * 3600_000) warn('VALID_UNTIL_WITHIN_48H', r.price_valid_until) }
      // Review heuristics only: flagged for a human look, never used to drop a row.
      if (n.regular && n.promo && (n.regular - n.promo) / n.regular >= 0.5) warn('DEEP_DISCOUNT_REVIEW', `${Math.round((n.regular - n.promo) / n.regular * 100)}%`)
      if (n.voucher && selling && n.voucher / selling >= 0.3) warn('LARGE_VOUCHER_REVIEW', `${Math.round(n.voucher / selling * 100)}% of selling price`)
    }
    const hardFail = issues.slice(before).some(i => i.severity === 'FAIL')
    klass.push(hardFail ? 'INVALID'
      : r.status === 'EXACT' && FRESH.has(r.review_status) ? 'ELIGIBLE_PRICED'
      : NO_PRICE_OUTCOMES.has(r.status) && FRESH.has(r.review_status) ? 'ELIGIBLE_NO_PRICE'
      : UNRESOLVED_STATUSES.has(r.status) || /^STALE_PILOT/.test(r.review_status) || r.review_status === 'NOT_CHECKED' ? 'UNRESOLVED' : 'UNRESOLVED')
  })
  for (const [url, lines] of urlUse) if (lines.length > 1) for (const line of lines) {
    const r = rows[line - 2]; issues.push({ line, dpg_id: r.dpg_id, sku: r.sku, severity: 'WARN', code: 'HITA_URL_SHARED', detail: `${lines.length} SKUs share ${url.slice(0, 70)}` })
  }
  return { fileIssues, issues, rows: rows.length, klass, header }
}

export function summarise(result: ReturnType<typeof validate>) {
  const count = <T,>(items: T[], key: (x: T) => string) => Object.fromEntries([...items.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + 1), new Map<string, number>())].sort())
  const rowsWith = (sev: Severity) => new Set(result.issues.filter(i => i.severity === sev).map(i => i.line)).size
  const eligibleWithWarn = new Set(result.issues.filter(i => i.severity === 'WARN').map(i => i.line))
  return {
    rows: result.rows, file_issues: result.fileIssues,
    by_class: count(result.klass, k => k),
    rows_with_fail: rowsWith('FAIL'), rows_with_warn: rowsWith('WARN'),
    eligible_priced_with_warnings: result.klass.filter((k, i) => k === 'ELIGIBLE_PRICED' && eligibleWithWarn.has(i + 2)).length,
    fail_by_code: count(result.issues.filter(i => i.severity === 'FAIL'), i => i.code),
    warn_by_code: count(result.issues.filter(i => i.severity === 'WARN'), i => i.code),
  }
}
