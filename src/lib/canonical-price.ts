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
/** Brands that may EVER be priced canonically (immutable Production ids verified read-only 24/11: toto=1, inax=2). Widening = reviewed code change. */
export const CANONICAL_APPROVED_BRANDS = ['toto', 'inax'] as const
export function canonicalProductionBrands(env: CanonicalEnv = process.env as CanonicalEnv): readonly string[] {
    const raw = env.PUBLIC_CANONICAL_PRICE_BRANDS
    if (raw === undefined) return ['toto']                       // flag ON without an explicit list = the first release scope only
    // an explicit list is intersected with the approved set (unknown/unsafe entries dropped; empty = no brand is priced)
    return CANONICAL_APPROVED_BRANDS.filter(brand => raw.split(',').map(value => value.trim()).includes(brand))
}
export const canonicalSortEnabled = (categorySlug: string, env: CanonicalEnv = process.env as CanonicalEnv): boolean =>
    categorySlug === 'thiet-bi-ve-sinh' && canonicalPricingMode(env) !== 'off'

// ── #470/#443 scope lock: series filter + variant selector (#432/#433/#440) are NOT accepted yet ───────────────────
// Production keeps them OFF (no sibling/series query, `dong`/series_slugs ignored, nothing rendered) unless PUBLIC_SERIES_VARIANT=on.
// TEST/staging/preview/local keep their existing behaviour. Defence in depth: 42501 degrade stays in live-public-catalogue.
export type SeriesVariantEnv = { APP_ENV?: string; PUBLIC_SERIES_VARIANT?: string }
export function seriesVariantEnabled(env: SeriesVariantEnv = process.env as SeriesVariantEnv): boolean {
    return env.APP_ENV !== 'production' || env.PUBLIC_SERIES_VARIANT === 'on'
}
