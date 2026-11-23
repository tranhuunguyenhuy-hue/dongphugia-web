import { toCsv } from './review-report.mts'

// #464 (Claude, independent of Codex #448): merge crawl checkpoints with the inventory into one CSV row per SKU.
export type Inv = { id: number; sku: string; name?: string; brand?: string; is_active: boolean }
export type Crawled = {
  dpg_id: number; dpg_sku: string; status: string; exception?: string | null; source_url?: string; retrieved_at_utc?: string | null
  regular_price_vnd: number | null; promotional_price_vnd: number | null; online_voucher_amount_vnd: number | null
  hita_exact_sku?: string | null; online_voucher_condition?: string | null
  evidence?: { voucher_condition?: string; offer?: { priceCurrency?: string; priceValidUntil?: string } | null } | null
}
export const CLAUDE_COLUMNS = ['dpg_id', 'sku', 'product_name', 'brand', 'is_active', 'hita_exact_sku', 'hita_url', 'regular_price_vnd', 'promotional_price_vnd',
  'online_voucher_amount_vnd', 'currency', 'source_checked_at_utc', 'price_valid_until', 'voucher_condition', 'status', 'reason', 'method', 'review_status'] as const
export const CLAUDE_EXCEPTION_COLUMNS = ['dpg_id', 'sku', 'hita_url', 'timestamp_utc', 'status', 'reason', 'method'] as const
type Row = Record<typeof CLAUDE_COLUMNS[number], string | number | boolean | null>
const money = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null)

// Newest terminal-or-not result per DPG id wins; a result for a different SKU than the inventory's is ignored.
export function latestByProduct(results: Crawled[]) {
  const map = new Map<number, Crawled>()
  for (const r of results) { const old = map.get(r.dpg_id); if (!old || String(r.retrieved_at_utc ?? '') >= String(old.retrieved_at_utc ?? '')) map.set(r.dpg_id, r) }
  return map
}
export function buildRows(inventory: Inv[], results: Crawled[], method: string): Row[] {
  const latest = latestByProduct(results)
  return inventory.map(inv => {
    const r = latest.get(inv.id)
    const base = { dpg_id: inv.id, sku: inv.sku, product_name: inv.name ?? '', brand: inv.brand ?? '', is_active: inv.is_active }
    if (!r || r.dpg_sku !== inv.sku) return { ...base, hita_exact_sku: '', hita_url: '', regular_price_vnd: null, promotional_price_vnd: null, online_voucher_amount_vnd: null, currency: '',
      source_checked_at_utc: '', price_valid_until: '', voucher_condition: '', status: 'NOT_CRAWLED', reason: 'PENDING', method, review_status: 'NOT_CRAWLED_PENDING' }
    const exact = r.status === 'EXACT'
    const url = r.source_url?.startsWith('https://hita.com.vn/') && !r.source_url.includes('/product/searchProduct') ? r.source_url : ''
    return { ...base, hita_exact_sku: r.hita_exact_sku ?? '', hita_url: url, regular_price_vnd: exact ? money(r.regular_price_vnd) : null,
      promotional_price_vnd: exact ? money(r.promotional_price_vnd) : null, online_voucher_amount_vnd: exact ? money(r.online_voucher_amount_vnd) : null,
      currency: exact ? (r.evidence?.offer?.priceCurrency ?? '') : '', source_checked_at_utc: r.retrieved_at_utc ?? '', price_valid_until: exact ? (r.evidence?.offer?.priceValidUntil ?? '') : '',
      voucher_condition: exact ? (r.online_voucher_condition ?? r.evidence?.voucher_condition ?? '') : '', status: r.status, reason: r.exception ?? '', method,
      review_status: r.status === 'BLOCKED' ? 'BLOCKED_NOT_NO_PRICE' : r.status === 'UNKNOWN' ? 'UNKNOWN_TECHNICAL' : 'FRESH_CRAWL_PENDING_OWNER_REVIEW' }
  })
}
export const exceptionsOf = (rows: Row[]) => rows.filter(r => r.status !== 'NOT_CRAWLED' && (r.status !== 'EXACT' || r.reason))
  .map(r => ({ dpg_id: r.dpg_id, sku: r.sku, hita_url: r.hita_url, timestamp_utc: r.source_checked_at_utc, status: r.status, reason: r.reason, method: r.method }))

export type RunInfo = { label: string; environment: string; startedAtUtc: string; requests: number; non2xx: number; haltReason: string | null; crawled: number }
export type Context = { prodSanitary: number; prodBrandTotal: number; prodBrandActive: number; brand: string; checkedAtUtc: string; runs: RunInfo[]; probes: string[] }
export function summary(rows: Row[], ctx: Context) {
  const c = (f: (r: Row) => boolean) => rows.filter(f).length
  const st = (s: string) => c(r => r.status === s)
  const visited = c(r => r.status !== 'NOT_CRAWLED')
  const exact = st('EXACT')
  const three = c(r => r.status === 'EXACT' && r.promotional_price_vnd !== null && r.online_voucher_amount_vnd !== null)
  const two = c(r => r.status === 'EXACT' && r.promotional_price_vnd !== null && r.online_voucher_amount_vnd === null)
  const one = c(r => r.status === 'EXACT' && r.promotional_price_vnd === null)
  const active = c(r => r.is_active === true), done = c(r => r.is_active === true && r.status !== 'NOT_CRAWLED')
  return `# Claude parallel Hita crawl — ${ctx.brand} (#464)

Độc lập với Codex #448: không dùng chung checkpoint/file. Chỉ crawl và xuất CSV; **không ghi database, không deploy, không đưa giá vào dữ liệu DPG**. Mọi dòng \`FRESH_CRAWL_PENDING_OWNER_REVIEW\` chờ Owner duyệt.

## Số liệu thực tế (${rows.length ? 'tại thời điểm xuất file' : ''})
| Mục | Số SKU |
|---|---:|
| Inventory ${ctx.brand} trên Production (chỉ đọc, ${ctx.checkedAtUtc}) | ${ctx.prodBrandTotal.toLocaleString('en-US')} (active ${ctx.prodBrandActive.toLocaleString('en-US')}) |
| Trong file này (active) | ${rows.length.toLocaleString('en-US')} |
| **Đã thăm (có kết quả)** | **${visited.toLocaleString('en-US')}** |
| Chưa làm | ${st('NOT_CRAWLED').toLocaleString('en-US')} |
| EXACT có ≥ giá gốc | ${exact.toLocaleString('en-US')} |
| — đủ 3 giá (gốc + KM + voucher) | ${three} |
| — 2 giá (gốc + KM) | ${two} |
| — 1 giá (chỉ giá gốc) | ${one} |
| — có voucher online | ${c(r => r.status === 'EXACT' && r.online_voucher_amount_vnd !== null)} |
| CONTACT / DISCONTINUED | ${st('CONTACT')} / ${st('DISCONTINUED')} |
| NOT_FOUND / AMBIGUOUS | ${st('NOT_FOUND')} / ${st('AMBIGUOUS')} |
| BLOCKED / UNKNOWN | ${st('BLOCKED')} / ${st('UNKNOWN')} |

Độ phủ: active ${ctx.brand} đã làm **${done}/${active}** (${active ? (done / active * 100).toFixed(1) : '0.0'}%); so với toàn ngành vệ sinh Production (${ctx.prodSanitary.toLocaleString('en-US')} SKU) mới **${visited}/${ctx.prodSanitary.toLocaleString('en-US')}** (${(visited / ctx.prodSanitary * 100).toFixed(2)}%). Inactive ${ctx.brand} và các thương hiệu khác chưa làm.

## Môi trường và phương pháp
${ctx.probes.map(p => `- ${p}`).join('\n')}

| Lượt chạy | Môi trường | Bắt đầu (UTC) | Request | Không 2xx | SKU thăm | Dừng vì |
|---|---|---|---:|---:|---:|---|
${ctx.runs.map(r => `| ${r.label} | ${r.environment} | ${r.startedAtUtc} | ${r.requests} | ${r.non2xx} | ${r.crawled} | ${r.haltReason ?? 'hết lát'} |`).join('\n')}

Crawler: Node \`fetch\` + Cheerio (PR #450) với batch/checkpoint (PR #461): search \`/product/searchProduct?key=<EXACT-SKU>\` → xác nhận \`product_code\` → PDP → đối chiếu SKU trên PDP, giá HTML và JSON-LD Offer (VND) → voucher chỉ nhận khi có điều kiện "đặt online". 1 request/giây, UA \`DongPhuGia-price-audit\`, dừng khi gặp 401/403/429/503/challenge. Không giải CAPTCHA/Turnstile, không proxy xoay vòng/stealth/giả định danh. BLOCKED/UNKNOWN **không** được hiểu là "Hita không có giá". Giá VND là số nguyên > 0 hoặc để trống (không dùng 0).

## File
- \`claude_hita_prices_review.csv\`: mỗi SKU một dòng (UTF-8 BOM, ô \`= + - @\` đã vô hiệu hóa công thức).
- \`claude_hita_exceptions.csv\`: CONTACT/DISCONTINUED/NOT_FOUND/AMBIGUOUS/BLOCKED/UNKNOWN và ngoại lệ voucher.
- \`claude_hita_checkpoint.jsonl\`: kết quả thô theo SKU để resume.
`
}
export { toCsv }
