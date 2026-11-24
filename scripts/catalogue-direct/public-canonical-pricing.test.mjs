import { describe, expect, it } from 'vitest'
import { CANONICAL_LABEL_CONTACT, CANONICAL_LABEL_UNVERIFIED, CANONICAL_PROVENANCE, canonicalPublicPricing, inCanonicalScope, isCanonicalPublicPricing } from './public-canonical-pricing.mjs'

const NOW = new Date('2026-11-25T00:00:00Z')
const fresh = '2026-11-24T20:00:00.000Z'
const row = (over = {}) => ({ categories: { slug: 'thiet-bi-ve-sinh' }, brand_slug: 'toto', canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '1000000',
  promotional_price_vnd: null, online_voucher_amount_vnd: null, canonical_price_checked_at: fresh,
  // legacy columns must be ignored completely
  price: 111, list_price: 111, sale_price: 100, original_price: 111, online_discount_amount: 5, price_state: 'priced', ...over })
const price = (over = {}) => canonicalPublicPricing(row(over), { now: NOW })

describe('#470 canonical public pricing (Architecture A)', () => {
  it('regular only: price = list, no promotion, legacy columns ignored', () => {
    const p = price(); expect(p).toMatchObject({ price: 1000000, list_price: 1000000, original_price: null, sale_price: null, is_promotion: false, online_discount_amount: null, final_online_price: null, price_display: null, price_provenance: CANONICAL_PROVENANCE })
    expect(isCanonicalPublicPricing(p)).toBe(true)
  })
  it('promotion: price = promotional, struck-through original = regular', () => {
    const p = price({ promotional_price_vnd: '900000' }); expect(p).toMatchObject({ price: 900000, original_price: 1000000, list_price: 1000000, sale_price: 900000, is_promotion: true })
    expect(isCanonicalPublicPricing(p)).toBe(true)
  })
  it('voucher is separate: it never lowers price or list price', () => {
    const p = price({ promotional_price_vnd: '900000', online_voucher_amount_vnd: '50000' })
    expect(p.price).toBe(900000); expect(p.list_price).toBe(1000000); expect(p.online_discount_amount).toBe(50000); expect(p.final_online_price).toBe(850000)
    expect(isCanonicalPublicPricing(p)).toBe(true)
    const v = price({ online_voucher_amount_vnd: '30000' }); expect(v.price).toBe(1000000); expect(v.final_online_price).toBe(970000)
  })
  it('CONTACT_VERIFIED and every non-verified state are different labels, never a price, never legacy', () => {
    expect(price({ canonical_price_status: 'CONTACT_VERIFIED', regular_price_vnd: null }).price_display).toBe(CANONICAL_LABEL_CONTACT)
    for (const status of ['UNRESOLVED', 'NOT_FOUND', 'DISCONTINUED', null, undefined, 'SOMETHING_NEW']) {
      const p = price({ canonical_price_status: status, regular_price_vnd: null })
      expect(p.price).toBeNull(); expect(p.price_display).toBe(CANONICAL_LABEL_UNVERIFIED); expect(p.price_display).not.toBe(CANONICAL_LABEL_CONTACT)
      expect(isCanonicalPublicPricing(p)).toBe(true)
    }
  })
  it('a row with legacy prices but no canonical status shows NO price (no legacy fallback)', () => {
    const p = price({ canonical_price_status: null, regular_price_vnd: null }); expect(p.price).toBeNull(); expect(p.list_price).toBeNull()
  })
  it('fails the build on stale / future / missing checked-at', () => {
    expect(() => price({ canonical_price_checked_at: '2026-11-10T00:00:00Z' })).toThrow('PUBLIC_CANONICAL_PRICE_STALE')
    expect(() => price({ canonical_price_checked_at: '2026-11-26T00:00:00Z' })).toThrow('PUBLIC_CANONICAL_PRICE_STALE')
    expect(() => price({ canonical_price_checked_at: null })).toThrow('PUBLIC_CANONICAL_PRICE_STALE')
    expect(canonicalPublicPricing(row({ canonical_price_checked_at: '2026-11-10T00:00:00Z' }), { now: NOW, maxAgeMs: 30 * 24 * 3600_000 }).price).toBe(1000000)
  })
  it('fails the build on inconsistent verified data', () => {
    expect(() => price({ regular_price_vnd: null })).toThrow('PUBLIC_CANONICAL_PRICE_INVALID')
    expect(() => price({ promotional_price_vnd: '1000000' })).toThrow('PUBLIC_CANONICAL_PRICE_INVALID')
    expect(() => price({ promotional_price_vnd: '900000', online_voucher_amount_vnd: '900000' })).toThrow('PUBLIC_CANONICAL_PRICE_INVALID')
    expect(() => price({ regular_price_vnd: '1.5' })).toThrow('PUBLIC_CANONICAL_PRICE_INVALID')
    expect(() => price({ regular_price_vnd: '0' })).toThrow('PUBLIC_CANONICAL_PRICE_INVALID')
  })
  it('scope: only the listed category AND brand; every other row is untouched', () => {
    const scope = { categories: ['thiet-bi-ve-sinh'], brands: ['toto'] }
    expect(inCanonicalScope(row(), scope)).toBe(true)
    expect(inCanonicalScope(row({ brand_slug: 'inax' }), scope)).toBe(false)
    expect(inCanonicalScope(row({ brand_slug: null }), scope)).toBe(false)
    expect(inCanonicalScope(row({ categories: { slug: 'gach-op-lat' } }), scope)).toBe(false)
    expect(inCanonicalScope(row(), undefined)).toBe(false)
  })
  it('the validator rejects tampered DTOs', () => {
    const p = price({ promotional_price_vnd: '900000' })
    for (const bad of [{ ...p, price_provenance: 'legacy-manual-2026-07-02' }, { ...p, price: 1100000 }, { ...p, sale_price: null }, { ...p, extra: 1 }, { ...p, price_display: 'x' }]) expect(isCanonicalPublicPricing(bad)).toBe(false)
    expect(isCanonicalPublicPricing({ ...price({ canonical_price_status: null }), price_display: 'Liên hệ báo giá nữa' })).toBe(false)
  })
})
