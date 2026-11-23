// #466-A CSV Quality Gate. Pure functions, no network, no DB. Reuses the column contract of the #448/#462/#465 CSVs.
// FAIL = hard error (the row can never be used). WARN = needs an Owner look (never auto-excluded by an arbitrary threshold).
export type Severity = 'FAIL' | 'WARN'
export type Issue = { line: number; dpg_id: string; sku: string; severity: Severity; code: string; detail: string }
// Owner rule 24/11 (#466): the verified Hita crawl is the standard price source; CONTACT, NOT_FOUND and AMBIGUOUS are three different outcomes.
//   PRICE_VERIFIED            EXACT SKU with a valid price set (still needs Owner approval before any import)
//   CONTACT_VERIFIED          Hita lists "Liên hệ báo giá": three prices NULL, UI shows "Liên hệ báo giá", old DPG price is NOT a fallback
//   NOT_FOUND_CANDIDATE_DELETE exact SKU not on Hita: a list for a FUTURE Owner decision, never an automatic delete/hide
//   DISCONTINUED_REVIEW       Hita discontinued: Owner decides the product lifecycle
//   AMBIGUOUS_UNVERIFIED      exact SKU not proven: no sibling price, not CONTACT, not a delete candidate
//   UNRESOLVED                NOT_CRAWLED / BLOCKED / UNKNOWN / stale pilot: no conclusion at all
export type Klass = 'PRICE_VERIFIED' | 'CONTACT_VERIFIED' | 'NOT_FOUND_CANDIDATE_DELETE' | 'DISCONTINUED_REVIEW' | 'AMBIGUOUS_UNVERIFIED' | 'UNRESOLVED' | 'INVALID'
export type InvRow = { id: number; sku: string; is_active: boolean }

export const REQUIRED_COLUMNS = ['dpg_id', 'sku', 'is_active', 'hita_exact_sku', 'hita_url', 'regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd',
  'currency', 'source_checked_at_utc', 'price_valid_until', 'voucher_condition', 'status', 'review_status'] as const
const STATUSES = new Set(['EXACT', 'CONTACT', 'DISCONTINUED', 'NOT_FOUND', 'AMBIGUOUS', 'BLOCKED', 'UNKNOWN', 'NOT_CRAWLED'])
const FRESH_CLASS: Record<string, Klass> = { EXACT: 'PRICE_VERIFIED', CONTACT: 'CONTACT_VERIFIED', NOT_FOUND: 'NOT_FOUND_CANDIDATE_DELETE', DISCONTINUED: 'DISCONTINUED_REVIEW', AMBIGUOUS: 'AMBIGUOUS_UNVERIFIED' }
const FRESH = new Set(['FRESH_CRAWL_PENDING_OWNER_REVIEW'])
const KNOWN_REVIEW = (v: string) => FRESH.has(v) || v === 'NOT_CHECKED' || v === 'NOT_CRAWLED_PENDING' || v === 'BLOCKED_NOT_NO_PRICE' || v === 'UNKNOWN_TECHNICAL' || /^STALE_PILOT/.test(v)
const PDP_URL = /^https:\/\/hita\.com\.vn\/[a-z0-9-]+-\d+\.html$/

// RFC 4180 parser: BOM, CRLF/LF, quoted fields with "" escapes and embedded newlines. Also reports malformed quoting.
export function parseCsvDetailed(text: string) {
  const table: string[][] = [], rowLine: number[] = [], strayQuoteRows: number[] = []
  let row: string[] = [], field = '', quoted = false, fieldStarted = false, line = 1, startLine = 1, stray = false, i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const endRow = () => { row.push(field); field = ''; fieldStarted = false; if (row.length > 1 || row[0] !== '') { table.push(row); rowLine.push(startLine); if (stray) strayQuoteRows.push(table.length) } row = []; stray = false; startLine = line }
  for (; i < text.length; i++) {
    const c = text[i]
    if (c === '\n') line++
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else { quoted = false; if (![',', '\n', '\r', undefined].includes(text[i + 1])) stray = true } } else field += c }
    else if (c === '"') { if (!fieldStarted) { quoted = true; fieldStarted = true } else { stray = true; field += c } }
    else if (c === ',') { row.push(field); field = ''; fieldStarted = false }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; endRow() }
    else { field += c; fieldStarted = true }
  }
  const unterminated = quoted
  if (field !== '' || row.length) endRow()
  return { table, rowLine, strayQuoteRows, unterminated }
}
export const parseCsv = (text: string) => parseCsvDetailed(text).table

const positiveInt = (v: string) => (/^[1-9]\d{0,11}$/.test(v) ? Number(v) : null)
export type Options = { now: Date; maxAgeHours?: number; inventory?: Map<number, InvRow> }

export function validate(csvText: string, opts: Options) {
  const issues: Issue[] = []
  const parsed = parseCsvDetailed(csvText), table = parsed.table
  const header = (table[0] ?? []).map(h => h.trim())
  const missing = REQUIRED_COLUMNS.filter(c => !header.includes(c))
  const fileIssues: string[] = [...missing.map(c => `MISSING_COLUMN:${c}`), ...(new Set(header).size !== header.length ? ['DUPLICATE_COLUMN'] : []), ...(parsed.unterminated ? ['UNTERMINATED_QUOTE'] : [])]
  const cellCount = table.slice(1).map(cells => cells.length)
  const rows = table.slice(1).map(cells => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])))
  const klass: Klass[] = []
  if (fileIssues.length) return { fileIssues, issues, rows: rows.length, klass, header, data: rows }
  const maxAgeMs = (opts.maxAgeHours ?? 24) * 3600_000
  const seenId = new Map<string, number>(), seenSku = new Map<string, number>(), urlUse = new Map<string, number[]>()
  rows.forEach((r, idx) => {
    const line = idx + 2, add = (severity: Severity, code: string, detail: string) => issues.push({ line, dpg_id: r.dpg_id, sku: r.sku, severity, code, detail })
    const fail = (code: string, detail = '') => add('FAIL', code, detail), warn = (code: string, detail = '') => add('WARN', code, detail)
    const before = issues.length
    if (cellCount[idx] !== header.length) fail('ROW_COLUMN_COUNT', `${cellCount[idx]} cells vs ${header.length} columns`)
    if (parsed.strayQuoteRows.includes(idx + 2)) fail('STRAY_QUOTE', 'misplaced double quote')
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
      if (FRESH.has(r.review_status) && FRESH_CLASS[r.status]) {
        const checked = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(r.source_checked_at_utc) ? Date.parse(r.source_checked_at_utc) : NaN
        if (!Number.isFinite(checked)) fail('OUTCOME_WITHOUT_TIMESTAMP', `${r.status} needs the UTC time of the check`)
        if (r.status === 'CONTACT' || r.status === 'DISCONTINUED') {      // both are read from the exact product page
          if (r.hita_exact_sku.trim().toUpperCase() !== skuKey) fail('OUTCOME_SKU_NOT_PROVEN', `${r.status} must come from the exact-SKU page`)
          if (!PDP_URL.test(r.hita_url)) fail('OUTCOME_URL_INVALID', `${r.status} needs the product page URL`)
        }
        if (r.status === 'NOT_FOUND' && r.hita_exact_sku.trim()) fail('NOT_FOUND_WITH_HITA_SKU', 'contradiction: NOT_FOUND must not name a Hita SKU')
      }
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
    klass.push(hardFail ? 'INVALID' : FRESH.has(r.review_status) && FRESH_CLASS[r.status] ? FRESH_CLASS[r.status] : 'UNRESOLVED')
  })
  for (const [url, lines] of urlUse) if (lines.length > 1) for (const line of lines) {
    const r = rows[line - 2]; issues.push({ line, dpg_id: r.dpg_id, sku: r.sku, severity: 'WARN', code: 'HITA_URL_SHARED', detail: `${lines.length} SKUs share ${url.slice(0, 70)}` })
  }
  return { fileIssues, issues, rows: rows.length, klass, header, data: rows }
}

export function summarise(result: ReturnType<typeof validate>) {
  const count = <T,>(items: T[], key: (x: T) => string) => Object.fromEntries([...items.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + 1), new Map<string, number>())].sort())
  const rowsWith = (sev: Severity) => new Set(result.issues.filter(i => i.severity === sev).map(i => i.line)).size
  const eligibleWithWarn = new Set(result.issues.filter(i => i.severity === 'WARN').map(i => i.line))
  return {
    rows: result.rows, file_issues: result.fileIssues,
    by_class: count(result.klass, k => k),
    rows_with_fail: rowsWith('FAIL'), rows_with_warn: rowsWith('WARN'),
    price_verified_with_warnings: result.klass.filter((k, i) => k === 'PRICE_VERIFIED' && eligibleWithWarn.has(i + 2)).length,
    fail_by_code: count(result.issues.filter(i => i.severity === 'FAIL'), i => i.code),
    warn_by_code: count(result.issues.filter(i => i.severity === 'WARN'), i => i.code),
  }
}

// Per-class lists for the Owner. They are review lists, NOT commands: nothing here deletes, hides or changes a product.
export const CLASS_EXPORTS: Array<{ klass: Klass; file: string; note: string }> = [
  { klass: 'CONTACT_VERIFIED', file: 'contact_verified.csv', note: 'Hita lists "Liên hệ báo giá": cả 3 giá phải NULL, Public hiển thị "Liên hệ báo giá"; không dùng giá DPG cũ làm dự phòng' },
  { klass: 'NOT_FOUND_CANDIDATE_DELETE', file: 'not_found_candidates.csv', note: 'Ứng viên để Owner xem xét xóa SAU NÀY. Đây KHÔNG phải lệnh xóa/ẩn; chưa thay đổi sản phẩm nào' },
  { klass: 'DISCONTINUED_REVIEW', file: 'discontinued_review.csv', note: 'Hita ngừng kinh doanh: Owner quyết định vòng đời sản phẩm; không tự xóa, không dùng giá cũ' },
  { klass: 'AMBIGUOUS_UNVERIFIED', file: 'ambiguous_unverified.csv', note: 'Chưa xác minh đúng SKU: giữ nguyên chờ kiểm tra; không lấy giá SKU tương tự, không gán CONTACT, không đưa vào danh sách xóa' },
]
export const EXPORT_COLUMNS = ['dpg_id', 'sku', 'is_active', 'hita_url', 'source_checked_at_utc', 'status', 'reason', 'regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd', 'future_action'] as const
export function exportClass(result: ReturnType<typeof validate>, klass: Klass, note: string) {
  return result.klass.map((k, i) => (k === klass ? result.data[i] : null)).filter((r): r is Record<string, string> => r !== null)
    .map(r => ({ ...Object.fromEntries(EXPORT_COLUMNS.map(c => [c, r[c] ?? ''])), future_action: note }))
}
