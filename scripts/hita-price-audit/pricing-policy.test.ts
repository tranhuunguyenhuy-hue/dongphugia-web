import { describe, expect, it } from 'vitest'
import { desiredPrices, NO_PRICE, planChange } from './pricing-policy.mts'

const row = (status: string, r: number | null = null, p: number | null = null, v: number | null = null) =>
  ({ status, regular_price_vnd: r, promotional_price_vnd: p, online_voucher_amount_vnd: v })

describe('#448 price policy', () => {
  it('EXACT writes the three Hita values (3, 2 and 1 level cases)', () => {
    expect(desiredPrices(row('EXACT', 1000, 900, 50))).toMatchObject({ action: 'WRITE', prices: { regular_price_vnd: 1000, promotional_price_vnd: 900, online_voucher_amount_vnd: 50 } })
    expect(desiredPrices(row('EXACT', 1000, 900, null))).toMatchObject({ action: 'WRITE', prices: { promotional_price_vnd: 900, online_voucher_amount_vnd: null } })
    expect(desiredPrices(row('EXACT', 1000, null, null))).toMatchObject({ action: 'WRITE', prices: { regular_price_vnd: 1000, promotional_price_vnd: null } })
  })
  it('contact / discontinued / not found / ambiguous write all-NULL (quote-only), never a fallback', () => {
    for (const status of ['CONTACT', 'DISCONTINUED', 'NOT_FOUND', 'AMBIGUOUS']) {
      expect(desiredPrices(row(status, 999, 888, 77))).toEqual({ action: 'WRITE', prices: NO_PRICE, reason: 'NO_VALID_SOURCE_PRICE', source_status: status })
    }
  })
  it('a technical failure (BLOCKED/UNKNOWN) is not evidence of "no price": leave the DB untouched', () => {
    for (const status of ['BLOCKED', 'UNKNOWN', 'SOMETHING_ELSE']) expect(desiredPrices(row(status, 1000, 900, 50)).action).toBe('SKIP')
  })
  it('quarantines internally inconsistent EXACT data instead of writing it', () => {
    expect(desiredPrices(row('EXACT', null, null, null))).toMatchObject({ action: 'QUARANTINE', reason: 'EXACT_WITHOUT_REGULAR_PRICE' })
    expect(desiredPrices(row('EXACT', 1000, 1000, null))).toMatchObject({ action: 'QUARANTINE', reason: 'PROMOTIONAL_NOT_BELOW_REGULAR' })
    expect(desiredPrices(row('EXACT', 1000, 1200, null))).toMatchObject({ action: 'QUARANTINE' })
    expect(desiredPrices(row('EXACT', 1000, 900, 900))).toMatchObject({ action: 'QUARANTINE', reason: 'VOUCHER_NOT_BELOW_SELLING_PRICE' })
    expect(desiredPrices(row('EXACT', 1000, null, 1000))).toMatchObject({ action: 'QUARANTINE' })
    expect(desiredPrices(row('EXACT', -5, null, null)).action).toBe('QUARANTINE')
    expect(desiredPrices(row('EXACT', 10.5, null, null)).action).toBe('QUARANTINE')
  })
  it('planChange is idempotent: equal values are a NOOP, otherwise lists exactly the changed keys', () => {
    const current = { regular_price_vnd: 1000, promotional_price_vnd: 900, online_voucher_amount_vnd: null, version: 4 }
    expect(planChange(current, { regular_price_vnd: 1000, promotional_price_vnd: 900, online_voucher_amount_vnd: null })).toEqual({ kind: 'NOOP' })
    expect(planChange(current, { regular_price_vnd: 1000, promotional_price_vnd: null, online_voucher_amount_vnd: 50 })).toMatchObject({
      kind: 'UPDATE', changed: ['promotional_price_vnd', 'online_voucher_amount_vnd'],
      before: { regular_price_vnd: 1000, promotional_price_vnd: 900, online_voucher_amount_vnd: null },
    })
  })
})
