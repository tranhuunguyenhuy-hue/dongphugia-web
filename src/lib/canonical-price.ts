// #446 TEST pilot ('hita-exact-test') and #470 Production snapshot ('hita-exact-v1') share one display contract:
// price/list/sale/voucher come from the exact-SKU canonical columns, the voucher is shown separately, and unpriced rows say why.
// Only the TEST pilot has a cart: the Production release (Owner decision 24/11/2026) keeps cart/checkout/order OFF.
export const CANONICAL_PROVENANCE_TEST = 'hita-exact-test'
export const CANONICAL_PROVENANCE_PRODUCTION = 'hita-exact-v1'
export const isCanonicalPriceProvenance = (value: unknown): boolean => value === CANONICAL_PROVENANCE_TEST || value === CANONICAL_PROVENANCE_PRODUCTION
export const canonicalCartEnabled = (value: unknown): boolean => value === CANONICAL_PROVENANCE_TEST
export const CANONICAL_CONTACT_LABEL = 'Liên hệ báo giá'
export const canonicalPriceLabel = (display: string | null | undefined): string => display?.trim() ? display : CANONICAL_CONTACT_LABEL

// ── #470 rollout flag (live PostgreSQL read path) ─────────────────────────────────────────────────────────────
// 'test'       isolated TEST Preview pilot (unchanged behaviour, 3 columns, provenance hita-exact-test)
// 'production' Production live read ONLY when PUBLIC_CANONICAL_PRICING === 'on' (default OFF; never set by code)
// 'off'        everything else: byte-identical queries/DTOs to before this feature.
export type CanonicalPricingMode = 'off' | 'test' | 'production'
export type CanonicalEnv = { APP_ENV?: string; PREVIEW_TEST_DATABASE_ISOLATED?: string; PUBLIC_CANONICAL_PRICING?: string; PUBLIC_CANONICAL_PRICE_BRANDS?: string }
export function canonicalPricingMode(env: CanonicalEnv = process.env as CanonicalEnv): CanonicalPricingMode {
    if (env.APP_ENV === 'staging' && env.PREVIEW_TEST_DATABASE_ISOLATED === 'true') return 'test'
    if (env.APP_ENV === 'production' && env.PUBLIC_CANONICAL_PRICING === 'on') return 'production'
    return 'off'
}
/** Production scope = sanitary x listed brands (default TOTO). Rows outside it are never touched by the flag. */
export function canonicalProductionBrands(env: CanonicalEnv = process.env as CanonicalEnv): readonly string[] {
    const brands = (env.PUBLIC_CANONICAL_PRICE_BRANDS ?? 'toto').split(',').map(value => value.trim()).filter(value => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))
    return brands.length ? brands : ['toto']
}
export const canonicalSortEnabled = (categorySlug: string, env: CanonicalEnv = process.env as CanonicalEnv): boolean =>
    categorySlug === 'thiet-bi-ve-sinh' && canonicalPricingMode(env) !== 'off'
