// #446 TEST pilot ('hita-exact-test') and #470 Production snapshot ('hita-exact-v1') share one display contract:
// price/list/sale/voucher come from the exact-SKU canonical columns, the voucher is shown separately, and unpriced rows say why.
// Only the TEST pilot has a cart: the Production release (Owner decision 24/11/2026) keeps cart/checkout/order OFF.
export const CANONICAL_PROVENANCE_TEST = 'hita-exact-test'
export const CANONICAL_PROVENANCE_PRODUCTION = 'hita-exact-v1'
export const isCanonicalPriceProvenance = (value: unknown): boolean => value === CANONICAL_PROVENANCE_TEST || value === CANONICAL_PROVENANCE_PRODUCTION
export const canonicalCartEnabled = (value: unknown): boolean => value === CANONICAL_PROVENANCE_TEST
export const CANONICAL_CONTACT_LABEL = 'Liên hệ báo giá'
export const canonicalPriceLabel = (display: string | null | undefined): string => display?.trim() ? display : CANONICAL_CONTACT_LABEL
