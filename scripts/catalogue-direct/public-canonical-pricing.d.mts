export const CANONICAL_PROVENANCE: 'hita-exact-v1'
export const CANONICAL_LABEL_CONTACT: string
export const CANONICAL_LABEL_UNVERIFIED: string
export const CANONICAL_PRICE_KEYS: readonly string[]
export type CanonicalPublicPricing = {
  price: number | null; original_price: number | null; list_price: number | null; sale_price: number | null
  online_discount_amount: number | null; final_online_price: number | null; price_display: string | null
  is_promotion: boolean; price_provenance: 'hita-exact-v1'
}
export type CanonicalPriceInput = {
  canonical_price_status?: string | null; regular_price_vnd?: number | string | bigint | null; promotional_price_vnd?: number | string | bigint | null
  online_voucher_amount_vnd?: number | string | bigint | null; canonical_price_checked_at?: Date | string | null
}
export function inCanonicalScope(input: { categories?: { slug?: string } | null; category_slug?: string | null; brand_slug?: string | null; brands?: { slug?: string } | null }, scope?: { categories: readonly string[]; brands: readonly string[] }): boolean
export function canonicalUnverifiedPricing(): CanonicalPublicPricing
export function canonicalPublicPricing(input: CanonicalPriceInput, options?: { now?: Date; maxAgeMs?: number; requireFresh?: boolean }): CanonicalPublicPricing
export function isCanonicalPublicPricing(value: unknown): boolean
