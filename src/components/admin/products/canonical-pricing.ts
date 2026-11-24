export const SANITARY_CATEGORY_SLUG = 'thiet-bi-ve-sinh'
/** #470: canonical (exact-SKU) price fields are only for these brands; every other sanitary brand keeps the legacy price fields.
 * Equals CANONICAL_APPROVED_BRANDS (src/lib/canonical-price.ts) and CANONICAL_ADMIN_BRANDS (admin-api); asserted by a test. */
export const CANONICAL_ADMIN_BRANDS = ['toto', 'inax'] as const

export const CANONICAL_PRICE_FIELDS = [
    'regular_price_vnd',
    'promotional_price_vnd',
    'online_voucher_amount_vnd',
] as const

export const LEGACY_PRICE_FIELDS = ['price', 'price_display', 'original_price', 'list_price', 'sale_price', 'online_discount_amount'] as const

type FieldName = typeof CANONICAL_PRICE_FIELDS[number]
type PriceDraft = Partial<Record<FieldName, unknown>>

export const PRICE_ERROR_TEXT = {
    PRICE_RELATION_INVALID: 'Nhập giá gốc và giá khuyến mãi bằng số nguyên VNĐ dương. Giá khuyến mãi phải nhỏ hơn giá gốc.',
    VOUCHER_INVALID: 'Voucher phải là số nguyên VNĐ dương và nhỏ hơn giá bán của sản phẩm.',
} as const

function wholeVnd(value: unknown): number | null {
    return value === '' || value == null ? null : Number(value)
}

export function validateCanonicalPricing(draft: PriceDraft): keyof typeof PRICE_ERROR_TEXT | null {
    const regular = wholeVnd(draft.regular_price_vnd)
    const promotion = wholeVnd(draft.promotional_price_vnd)
    const voucher = wholeVnd(draft.online_voucher_amount_vnd)
    const valid = (amount: number | null) => amount === null
        || (Number.isSafeInteger(amount) && amount > 0 && amount <= 9_999_999_999_999)

    if (!valid(regular) || !valid(promotion) || (promotion !== null && (regular === null || promotion >= regular))) {
        return 'PRICE_RELATION_INVALID'
    }
    const sale = promotion ?? regular
    if (!valid(voucher) || (voucher !== null && (sale === null || voucher >= sale))) return 'VOUCHER_INVALID'
    return null
}
