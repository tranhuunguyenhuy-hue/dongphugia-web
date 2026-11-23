import { describe, expect, it } from 'vitest'
import { applyOnlineVoucher, cartTotal, requantifyLine } from './cart-pricing'

describe('cart voucher (#446)', () => {
    it('deducts the voucher once per unit x quantity', () => {
        const line = applyOnlineVoucher({ unitPrice: 900_000, voucherAmount: 50_000, quantity: 2 })!
        expect(line).toMatchObject({ unitPriceBefore: 900_000, voucherPerUnit: 50_000, finalUnitPrice: 850_000, lineTotalBefore: 1_800_000, voucherTotal: 100_000, lineTotal: 1_700_000 })
    })
    it('never deducts again when quantity changes, refreshes or is re-read', () => {
        const line = applyOnlineVoucher({ unitPrice: 900_000, voucherAmount: 50_000, quantity: 1 })!
        const three = requantifyLine(line, 3)!
        expect(three.finalUnitPrice).toBe(850_000)
        expect(three.lineTotal).toBe(2_550_000)
        expect(requantifyLine(three, 3)).toEqual(three)
        expect(requantifyLine(requantifyLine(three, 1)!, 3)).toEqual(three)
    })
    it('ignores missing, zero, negative, decimal or non-reducing vouchers', () => {
        for (const voucherAmount of [null, undefined, 0, -1, 0.5, 900_000, 1_000_000]) {
            expect(applyOnlineVoucher({ unitPrice: 900_000, voucherAmount, quantity: 1 })).toMatchObject({ voucherPerUnit: 0, finalUnitPrice: 900_000 })
        }
    })
    it('rejects non-positive prices and invalid quantities (quote-only never enters the cart)', () => {
        expect(applyOnlineVoucher({ unitPrice: 0, voucherAmount: 1, quantity: 1 })).toBeNull()
        expect(applyOnlineVoucher({ unitPrice: 1000.5, voucherAmount: 1, quantity: 1 })).toBeNull()
        for (const quantity of [0, -1, 100, 1.5]) expect(applyOnlineVoucher({ unitPrice: 1000, voucherAmount: 1, quantity })).toBeNull()
    })
    it('sums mixed lines and removal simply drops the line', () => {
        const a = applyOnlineVoucher({ unitPrice: 900_000, voucherAmount: 50_000, quantity: 1 })!
        const b = applyOnlineVoucher({ unitPrice: 500_000, voucherAmount: null, quantity: 3 })!
        expect(cartTotal([a, b])).toBe(850_000 + 1_500_000)
        expect(cartTotal([b])).toBe(1_500_000)
    })
})
