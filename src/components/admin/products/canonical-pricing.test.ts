import { describe, expect, it } from 'vitest'
import { validateCanonicalPricing } from './canonical-pricing'

describe('Admin Hita price validation', () => {
    it.each([
        {},
        { regular_price_vnd: '', promotional_price_vnd: null, online_voucher_amount_vnd: '' },
        { regular_price_vnd: '1000000', promotional_price_vnd: '900000', online_voucher_amount_vnd: '50000' },
        { regular_price_vnd: '1000000', online_voucher_amount_vnd: '50000' },
    ])('accepts nullable and valid whole-VND values %j', draft => {
        expect(validateCanonicalPricing(draft)).toBeNull()
    })

    it.each([
        { regular_price_vnd: '0' },
        { regular_price_vnd: '99.99' },
        { regular_price_vnd: '10000000000000' },
        { promotional_price_vnd: '900000' },
        { regular_price_vnd: '1000000', promotional_price_vnd: '1000000' },
    ])('rejects invalid regular or promotional prices %j', draft => {
        expect(validateCanonicalPricing(draft)).toBe('PRICE_RELATION_INVALID')
    })

    it.each([
        { online_voucher_amount_vnd: '50000' },
        { regular_price_vnd: '1000000', online_voucher_amount_vnd: '-1' },
        { regular_price_vnd: '1000000', promotional_price_vnd: '900000', online_voucher_amount_vnd: '900000' },
    ])('rejects invalid vouchers %j', draft => {
        expect(validateCanonicalPricing(draft)).toBe('VOUCHER_INVALID')
    })
})

import { CANONICAL_ADMIN_BRANDS } from './canonical-pricing'
import { CANONICAL_APPROVED_BRANDS } from '@/lib/canonical-price'
it('#470: the Admin form brand allowlist equals the runtime allowlist', () => { expect([...CANONICAL_ADMIN_BRANDS]).toEqual([...CANONICAL_APPROVED_BRANDS]) })
