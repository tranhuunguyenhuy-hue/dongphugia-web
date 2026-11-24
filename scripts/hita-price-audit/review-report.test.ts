import { describe, expect, it } from 'vitest'
import { buildReviewRows, exceptionRows, REVIEW_COLUMNS, summaryMarkdown, toCsv, type SourceResult } from './review-report.mts'

const opts = { pilotLabel: 'STALE_PILOT_2026-11-22', blockedReason: 'LIVE_BLOCKED:HTTP_403_OR_CHALLENGE', blockedAtUtc: '2026-11-23T18:08:43Z' }
const inv = [{ id: 1, sku: 'A-1', is_active: true, name: 'Chậu A' }, { id: 2, sku: 'B-2', is_active: false, name: '=cmd|x' }, { id: 3, sku: 'FX-M3-001', is_active: true }, { id: 4, sku: 'C-4', is_active: true, name: 'Vòi C' }]
const exact = (id: number, sku: string, r: number | null, p: number | null, v: number | null): SourceResult => ({ dpg_id: id, dpg_sku: sku, status: 'EXACT', regular_price_vnd: r, promotional_price_vnd: p, online_voucher_amount_vnd: v,
  hita_exact_sku: sku, source_url: `https://hita.com.vn/x-${id}.html`, retrieved_at_utc: '2026-11-22T19:11:00Z', online_voucher_condition: 'Đặt Online', evidence: { offer: { priceCurrency: 'VND', priceValidUntil: '2026-12-31' } } })

describe('#448 review pack', () => {
  it('one row per real SKU, synthetic fixtures dropped, pilot labelled STALE, uncrawled labelled BLOCKED (not "no price")', () => {
    const rows = buildReviewRows(inv, new Map(), new Map([[1, exact(1, 'A-1', 1000, 900, 50)]]), opts)
    expect(rows.map(r => r.sku)).toEqual(['A-1', 'B-2', 'C-4'])
    expect(rows[0]).toMatchObject({ review_status: 'STALE_PILOT_2026-11-22', regular_price_vnd: 1000, promotional_price_vnd: 900, online_voucher_amount_vnd: 50, currency: 'VND', price_valid_until: '2026-12-31', source_checked_at_utc: '2026-11-22T19:11:00Z' })
    expect(rows[1]).toMatchObject({ status: 'BLOCKED', review_status: 'NOT_CRAWLED_LIVE_BLOCKED', regular_price_vnd: null, reason: 'LIVE_BLOCKED:HTTP_403_OR_CHALLENGE' })
  })
  it('fresh crawl wins over pilot; a SKU mismatch never reuses another SKU data; prices are positive integers or empty', () => {
    const fresh = new Map([[1, exact(1, 'A-1', 2000, null, null)]])
    const pilot = new Map([[1, exact(1, 'A-1', 1000, 900, 50)], [4, exact(4, 'OTHER', 5, null, null)], [2, exact(2, 'B-2', 0, -1, 1.5)]])
    const rows = buildReviewRows(inv, fresh, pilot, opts)
    expect(rows[0]).toMatchObject({ review_status: 'FRESH_CRAWL_PENDING_OWNER_REVIEW', regular_price_vnd: 2000, promotional_price_vnd: null })
    expect(rows[1]).toMatchObject({ regular_price_vnd: null, promotional_price_vnd: null, online_voucher_amount_vnd: null })
    expect(rows[2].review_status).toBe('NOT_CRAWLED_LIVE_BLOCKED')
  })
  it('does not leak a search URL as the product URL and keeps non-EXACT statuses without prices', () => {
    const contact: SourceResult = { ...exact(1, 'A-1', 100, null, null), status: 'CONTACT', exception: 'SOURCE_CONTACT', source_url: 'https://hita.com.vn/product/searchProduct?key=A-1' }
    const [row] = buildReviewRows([inv[0]], new Map(), new Map([[1, contact]]), opts)
    expect(row).toMatchObject({ hita_url: '', regular_price_vnd: null, status: 'CONTACT', reason: 'SOURCE_CONTACT' })
    expect(exceptionRows([row])).toHaveLength(1)
  })
  it('CSV is Excel-safe: BOM, CRLF, header, escaped quotes, formula injection neutralised, empty (not 0) for no price', () => {
    const rows = buildReviewRows(inv, new Map(), new Map(), opts)
    rows[0].product_name = 'He said "hi", ok'
    const csv = toCsv(REVIEW_COLUMNS, rows)
    expect(csv.startsWith('﻿"')).toBe(false)
    expect(csv.startsWith('﻿dpg_id,sku,product_name')).toBe(true)
    expect(csv).toContain('\r\n')
    expect(csv).toContain('"He said ""hi"", ok"')
    expect(csv).toContain(`"'=cmd|x"`)
    expect(csv).not.toMatch(/"0"/)
  })
  it('summary states LIVE_BLOCKED, real fresh count 0, and never claims whole-category coverage', () => {
    const rows = buildReviewRows(inv, new Map(), new Map([[1, exact(1, 'A-1', 1000, 900, 50)]]), opts)
    const md = summaryMarkdown({ rows, scope: { inventoryTotal: 4, synthetic: 1 }, files: ['a.csv'],
      coverage: { prodTotal: 16447, prodActive: 5344, prodDistinct: 16447, prodCheckedAtUtc: '2026-11-23T18:00Z' },
      attempt: { startedAtUtc: '2026-11-23T18:08:43Z', httpRequests: 1, non2xx: 1, haltReason: 'HTTP_403_OR_CHALLENGE', firstStatus: 403 } })
    expect(md).toContain('LIVE_BLOCKED')
    expect(md).toContain('| **Crawl mới thành công trong lượt này** | **0** |')
    expect(md).toContain('Không được hiểu đây là toàn ngành')
    expect(md).toContain('16,447')
    expect(md).toContain('BLOCKED ≠ "Hita không có giá"')
  })
})

it('keeps a verified single price in the export and leaves promotion and voucher blank', () => {
  const [row] = buildReviewRows(inv.slice(0, 1), new Map([[1, exact(1, 'A-1', 3_640_000, null, null)]]), new Map(), opts)
  expect(toCsv(REVIEW_COLUMNS, [row])).toContain('"3640000","","","VND"')
})
