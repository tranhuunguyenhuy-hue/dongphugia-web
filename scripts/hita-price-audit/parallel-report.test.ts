import { describe, expect, it } from 'vitest'
import { buildRows, exceptionsOf, latestByProduct, summary, type Crawled } from './parallel-report.mts'

const inv = [{ id: 1, sku: 'A', name: 'Chậu A', brand: 'TOTO', is_active: true }, { id: 2, sku: 'B', name: '@evil', brand: 'TOTO', is_active: true }, { id: 3, sku: 'C', brand: 'TOTO', is_active: true }, { id: 4, sku: 'D', brand: 'TOTO', is_active: true }]
const res = (id: number, sku: string, status: string, r: number | null, p: number | null, v: number | null, at = '2026-11-23T19:00:00Z'): Crawled => ({ dpg_id: id, dpg_sku: sku, status, regular_price_vnd: r, promotional_price_vnd: p,
  online_voucher_amount_vnd: v, retrieved_at_utc: at, source_url: `https://hita.com.vn/p-${id}.html`, hita_exact_sku: sku, exception: null, evidence: { offer: { priceCurrency: 'VND', priceValidUntil: '2026-12-01' }, voucher_condition: 'Đặt Online' } })
const ctx = { prodSanitary: 16447, prodBrandTotal: 4441, prodBrandActive: 2057, brand: 'TOTO', checkedAtUtc: 'T', probes: ['probe'], runs: [] }

describe('#464 parallel report', () => {
  it('one row per inventory SKU; uncrawled is NOT_CRAWLED (never "no price"); prices stay empty, never 0', () => {
    const rows = buildRows(inv, [res(1, 'A', 'EXACT', 1000, 900, 50), res(2, 'B', 'CONTACT', 5, null, null), res(4, 'WRONG', 'EXACT', 1, null, null)], 'M')
    expect(rows.map(r => r.status)).toEqual(['EXACT', 'CONTACT', 'NOT_CRAWLED', 'NOT_CRAWLED'])
    expect(rows[0]).toMatchObject({ regular_price_vnd: 1000, promotional_price_vnd: 900, online_voucher_amount_vnd: 50, currency: 'VND', price_valid_until: '2026-12-01', method: 'M', review_status: 'FRESH_CRAWL_PENDING_OWNER_REVIEW' })
    expect(rows[1]).toMatchObject({ regular_price_vnd: null })     // CONTACT never carries a price
    expect(rows[3]).toMatchObject({ review_status: 'NOT_CRAWLED_PENDING', regular_price_vnd: null })   // SKU mismatch is ignored
  })
  it('keeps the newest result per product and marks BLOCKED/UNKNOWN distinctly', () => {
    const latest = latestByProduct([res(1, 'A', 'UNKNOWN', null, null, null, '2026-11-23T18:00:00Z'), res(1, 'A', 'EXACT', 7, null, null, '2026-11-23T19:00:00Z')])
    expect(latest.get(1)?.status).toBe('EXACT')
    const rows = buildRows(inv, [res(3, 'C', 'BLOCKED', null, null, null), res(4, 'D', 'UNKNOWN', null, null, null)], 'M')
    expect(rows[2].review_status).toBe('BLOCKED_NOT_NO_PRICE'); expect(rows[3].review_status).toBe('UNKNOWN_TECHNICAL')
  })
  it('exceptions exclude pending rows and include every non-EXACT outcome', () => {
    const rows = buildRows(inv, [res(1, 'A', 'EXACT', 1, null, null), res(2, 'B', 'NOT_FOUND', null, null, null), res(3, 'C', 'BLOCKED', null, null, null)], 'M')
    expect(exceptionsOf(rows).map(e => e.status)).toEqual(['NOT_FOUND', 'BLOCKED'])
  })
  it('summary reports real counts and the true coverage, never whole-category', () => {
    const rows = buildRows(inv, [res(1, 'A', 'EXACT', 1000, 900, 50), res(2, 'B', 'EXACT', 1000, null, null)], 'M')
    const md = summary(rows, ctx)
    expect(md).toContain('| **Đã thăm (có kết quả)** | **2** |')
    expect(md).toContain('| Chưa làm | 2 |')
    expect(md).toContain('— đủ 3 giá (gốc + KM + voucher) | 1 |')
    expect(md).toContain('2/16,447')
    expect(md).toContain('không ghi database')
  })
})
