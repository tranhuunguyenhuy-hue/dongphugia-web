import type { InventoryRow } from './batch-plan.mts'
import { isSyntheticFixtureSku } from './batch-plan.mts'

// #448 Owner review pack. Pure functions. Nothing here writes to a database. A SKU that was NOT crawled is reported as
// BLOCKED / NOT_CRAWLED, never as "no price", and an old pilot price is labelled STALE, never as a new price.
export type NamedInventoryRow = InventoryRow & { name?: string }
export type SourceResult = {
  dpg_id: number; dpg_sku: string; status: string; exception?: string | null; source_url?: string; retrieved_at_utc?: string | null
  regular_price_vnd: number | null; promotional_price_vnd: number | null; online_voucher_amount_vnd: number | null; hita_exact_sku?: string | null
  online_voucher_condition?: string | null
  evidence?: { voucher_condition?: string; offer?: { priceCurrency?: string; priceValidUntil?: string } | null } | null
}
export const REVIEW_COLUMNS = ['dpg_id', 'sku', 'product_name', 'category', 'is_active', 'hita_exact_sku', 'hita_url', 'regular_price_vnd', 'promotional_price_vnd',
  'online_voucher_amount_vnd', 'currency', 'source_checked_at_utc', 'price_valid_until', 'voucher_condition', 'status', 'reason', 'review_status'] as const
export const EXCEPTION_COLUMNS = ['dpg_id', 'sku', 'hita_url', 'timestamp_utc', 'status', 'reason', 'review_status'] as const
export type ReviewRow = Record<typeof REVIEW_COLUMNS[number], string | number | boolean | null>
export type ReviewOptions = { pilotLabel: string; blockedReason: string | null; blockedAtUtc: string | null }

const money = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null)   // never 0, never negative

export function buildReviewRows(inventory: NamedInventoryRow[], fresh: Map<number, SourceResult>, pilot: Map<number, SourceResult>, opts: ReviewOptions): ReviewRow[] {
  return inventory.filter(r => !isSyntheticFixtureSku(r.sku)).map(inv => {
    const f = fresh.get(inv.id), p = pilot.get(inv.id)
    const src = f && f.dpg_sku === inv.sku ? f : undefined
    const old = !src && p && p.dpg_sku === inv.sku ? p : undefined
    const used = src ?? old
    const review_status = src ? 'FRESH_CRAWL_PENDING_OWNER_REVIEW' : old ? opts.pilotLabel : 'NOT_CRAWLED_LIVE_BLOCKED'
    const base = { dpg_id: inv.id, sku: inv.sku, product_name: inv.name ?? '', category: 'thiet-bi-ve-sinh', is_active: inv.is_active }
    if (!used) return { ...base, hita_exact_sku: '', hita_url: '', regular_price_vnd: null, promotional_price_vnd: null, online_voucher_amount_vnd: null, currency: '',
      source_checked_at_utc: opts.blockedAtUtc, price_valid_until: '', voucher_condition: '', status: 'BLOCKED', reason: opts.blockedReason ?? 'NOT_CRAWLED', review_status }
    const exact = used.status === 'EXACT'
    return { ...base, hita_exact_sku: used.hita_exact_sku ?? '', hita_url: used.source_url?.startsWith('https://hita.com.vn/') && !used.source_url.includes('/product/searchProduct') ? used.source_url : '',
      regular_price_vnd: exact ? money(used.regular_price_vnd) : null, promotional_price_vnd: exact ? money(used.promotional_price_vnd) : null,
      online_voucher_amount_vnd: exact ? money(used.online_voucher_amount_vnd) : null,
      currency: exact ? (used.evidence?.offer?.priceCurrency ?? '') : '', source_checked_at_utc: used.retrieved_at_utc ?? '',
      price_valid_until: exact ? (used.evidence?.offer?.priceValidUntil ?? '') : '', voucher_condition: used.online_voucher_condition ?? used.evidence?.voucher_condition ?? '',
      status: used.status, reason: used.exception ?? '', review_status }
  })
}

export function exceptionRows(rows: ReviewRow[]) {
  return rows.filter(r => r.status !== 'EXACT' || r.reason).map(r => ({ dpg_id: r.dpg_id, sku: r.sku, hita_url: r.hita_url, timestamp_utc: r.source_checked_at_utc, status: r.status, reason: r.reason, review_status: r.review_status }))
}

// Excel-safe CSV: UTF-8 BOM, CRLF, quotes escaped, cells starting with = + - @ TAB CR neutralised (formula injection).
export function toCsv(columns: readonly string[], rows: Array<Record<string, unknown>>) {
  const cell = (value: unknown) => {
    if (value === null || value === undefined) return '""'
    let text = String(value)
    if (typeof value === 'string' && /^[\s﻿]*[=+\-@\t\r]/.test(value)) text = "'" + text
    return '"' + text.replaceAll('"', '""') + '"'
  }
  return '﻿' + [columns.join(','), ...rows.map(row => columns.map(c => cell(row[c])).join(','))].join('\r\n') + '\r\n'
}

export type Coverage = { prodTotal: number; prodActive: number; prodDistinct: number; prodCheckedAtUtc: string }
export type Attempt = { startedAtUtc: string; httpRequests: number; non2xx: number; haltReason: string | null; firstStatus: number | null }
export function summaryMarkdown({ rows, scope, coverage, attempt, files }: { rows: ReviewRow[]; scope: { inventoryTotal: number; synthetic: number }; coverage: Coverage; attempt: Attempt; files: string[] }) {
  const n = (f: (r: ReviewRow) => boolean) => rows.filter(f).length
  const by = (key: 'status' | 'review_status') => [...new Set(rows.map(r => String(r[key])))].sort().map(k => `| ${k} | ${n(r => String(r[key]) === k)} |`).join('\n')
  const stale = (r: ReviewRow) => String(r.review_status).startsWith('STALE_PILOT')
  const fresh = n(r => r.review_status === 'FRESH_CRAWL_PENDING_OWNER_REVIEW')
  const live = attempt.haltReason ? `LIVE_BLOCKED (\`${attempt.haltReason}\`)` : 'OK'
  return `# Hita price crawl — review summary (#448)

**Trạng thái crawl live: ${live}.** Không có giá mới nào được lấy trong lần chạy này. Không ghi database (TEST hay Production), không deploy.

## 1. Độ phủ so với inventory Production
| Mục | Số lượng |
|---|---|
| SKU ngành \`thiet-bi-ve-sinh\` trên Production (chỉ đọc, ${coverage.prodCheckedAtUtc}) | **${coverage.prodTotal.toLocaleString('en-US')}** |
| — đang hiển thị (\`is_active\`) | ${coverage.prodActive.toLocaleString('en-US')} |
| — SKU phân biệt (không trùng, không rỗng) | ${coverage.prodDistinct.toLocaleString('en-US')} |
| SKU trong file CSV này (SKU thật của inventory TEST, bỏ ${scope.synthetic} fixture tổng hợp) | ${rows.length} |
| **Crawl mới thành công trong lượt này** | **${fresh}** |
| Có bằng chứng giá CŨ (pilot 22/11, không phải giá mới) | ${n(stale)} |
| Chưa crawl do bị chặn | ${n(r => r.review_status === 'NOT_CRAWLED_LIVE_BLOCKED')} |
| Production chưa có trong file | ${(coverage.prodTotal - rows.length).toLocaleString('en-US')} |

**Không được hiểu đây là toàn ngành.** Tối đa ${rows.length}/${coverage.prodTotal.toLocaleString('en-US')} SKU (${(rows.length / coverage.prodTotal * 100).toFixed(2)}%) có dòng trong CSV, và chỉ ${n(stale)} dòng có bằng chứng giá (cũ).

## 2. Lần thử crawl live
- Bắt đầu: ${attempt.startedAtUtc} (UTC), công cụ: \`scripts/hita-price-audit/batch.mts\` (Node fetch + Cheerio, kế thừa #450 và #461), 1 request/giây, User-Agent trung thực.
- Số request thực tế: **${attempt.httpRequests}**, không phải 2xx: **${attempt.non2xx}**${attempt.firstStatus ? `, mã đầu tiên: HTTP ${attempt.firstStatus}` : ''}.
- Kết quả: ${attempt.haltReason ? `Hita trả Cloudflare challenge (\`cf-mitigated: challenge\`) ngay ở \`robots.txt\`; crawler dừng theo quy tắc, **không** giải challenge, không đổi IP/UA/proxy, không dùng runner khác để né chặn.` : 'không bị chặn.'}
- BLOCKED ≠ "Hita không có giá": các SKU này **không** được kết luận là không có giá.

## 3. Phân bố trong CSV
| status | số dòng |
|---|---|
${by('status')}

| review_status | số dòng |
|---|---|
${by('review_status')}

Giá đã xác minh (từ bằng chứng pilot 22/11, **cũ**): có giá gốc ${n(r => r.regular_price_vnd !== null)}, có giá KM ${n(r => r.promotional_price_vnd !== null)}, có voucher ${n(r => r.online_voucher_amount_vnd !== null)}, không giá (CONTACT/DISCONTINUED/NOT_FOUND/AMBIGUOUS) ${n(r => ['CONTACT', 'DISCONTINUED', 'NOT_FOUND', 'AMBIGUOUS'].includes(String(r.status)))}. Giá VND là số nguyên > 0 hoặc để trống (không dùng 0).

## 4. File
${files.map(f => `- \`${f}\``).join('\n')}

Mở bằng Excel: UTF-8 có BOM, ô bắt đầu bằng \`=\` \`+\` \`-\` \`@\` đã được vô hiệu hóa công thức.

## 5. Còn lại để hoàn thành toàn ngành
1. Hita cho phép truy cập (hoặc cấp nguồn dữ liệu chính thức / chạy trên máy được truy cập hợp lệ).
2. Xuất inventory Production chỉ đọc (id, sku, tên, is_active) rồi chạy \`batch.mts\` có checkpoint/resume; ví dụ SQL chỉ đọc: \`select p.id, p.sku, p.name, p.is_active from dpg_app.products p join dpg_app.categories c on c.id = p.category_id where c.slug = 'thiet-bi-ve-sinh' order by p.id\`.
3. Owner duyệt tập dữ liệu mới trước mọi bước ghi DB hoặc #449.
`
}
