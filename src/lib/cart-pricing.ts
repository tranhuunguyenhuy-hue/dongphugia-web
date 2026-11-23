// #446 canonical price contract for the cart (category thiet-bi-ve-sinh, Hita exact SKU).
// The online voucher is shown separately on PDP/cards and is deducted exactly ONCE, when the line is added to the cart:
// per unit x quantity. Everything after that (quantity edits, refresh, checkout) multiplies the stored final unit price and
// must never call applyOnlineVoucher again. The server (guest order function) re-derives prices from the database.

export interface VoucherLineInput {
    /** Selling price shown on PDP/card: promotional price ?? regular price. */
    unitPrice: number
    /** online_voucher_amount_vnd per unit, or null/undefined when the SKU has none. */
    voucherAmount: number | null | undefined
    quantity: number
}

export interface PricedCartLine {
    unitPriceBefore: number
    voucherPerUnit: number
    finalUnitPrice: number
    quantity: number
    lineTotalBefore: number
    voucherTotal: number
    lineTotal: number
}

const isVnd = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** Returns null when the unit price is not a positive whole VND amount (quote-only SKUs never reach the cart). */
export function applyOnlineVoucher({ unitPrice, voucherAmount, quantity }: VoucherLineInput): PricedCartLine | null {
    if (!isVnd(unitPrice) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) return null
    // A voucher that is missing, non-positive or not strictly below the selling price is ignored (never a negative/zero price).
    const voucherPerUnit = isVnd(voucherAmount) && voucherAmount < unitPrice ? voucherAmount : 0
    const finalUnitPrice = unitPrice - voucherPerUnit
    return {
        unitPriceBefore: unitPrice,
        voucherPerUnit,
        finalUnitPrice,
        quantity,
        lineTotalBefore: unitPrice * quantity,
        voucherTotal: voucherPerUnit * quantity,
        lineTotal: finalUnitPrice * quantity,
    }
}

/** Re-quantity of an already priced line: uses the stored values only, so the voucher can never be deducted twice. */
export function requantifyLine(line: PricedCartLine, quantity: number): PricedCartLine | null {
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) return null
    return {
        ...line,
        quantity,
        lineTotalBefore: line.unitPriceBefore * quantity,
        voucherTotal: line.voucherPerUnit * quantity,
        lineTotal: line.finalUnitPrice * quantity,
    }
}

export const cartTotal = (lines: readonly PricedCartLine[]) => lines.reduce((sum, line) => sum + line.lineTotal, 0)
