// #470 Architecture A (Owner decision 2026-11-24): Public Production keeps reading the static snapshot; for the approved
// scope (sanitary + listed brands) the snapshot price comes ONLY from the canonical exact-SKU columns imported from the
// approved Hita CSV. Never from legacy price columns, never from sibling SKUs. Pure functions: no network, no database.
export const CANONICAL_PROVENANCE = 'hita-exact-v1'
export const CANONICAL_LABEL_CONTACT = 'Liên hệ báo giá'               // CONTACT_VERIFIED: Hita itself says "contact"
export const CANONICAL_LABEL_UNVERIFIED = 'Cần liên hệ xác nhận giá'  // UNRESOLVED / NULL / NOT_FOUND / DISCONTINUED: no verified source, never claimed as CONTACT
const MAX_VND = 9_999_999_999_999
const DEFAULT_MAX_AGE_MS = 7 * 24 * 3600_000
export const CANONICAL_PRICE_KEYS = ['price', 'original_price', 'list_price', 'sale_price', 'online_discount_amount', 'final_online_price', 'price_display', 'is_promotion', 'price_provenance']

const vnd = value => {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'bigint' ? Number(value) : Number(value)
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_VND ? n : NaN
}

/** Which rows the canonical rules govern. Everything outside keeps its existing (legacy-restored) behaviour untouched. */
export function inCanonicalScope(input, scope) {
  if (!scope) return false
  const category = input.categories?.slug ?? input.category_slug ?? null
  const brand = input.brand_slug ?? input.brands?.slug ?? null
  return Array.isArray(scope.categories) && scope.categories.includes(category)
    && Array.isArray(scope.brands) && brand !== null && scope.brands.includes(brand)
}

const unpriced = label => ({
  price: null, original_price: null, list_price: null, sale_price: null, online_discount_amount: null, final_online_price: null,
  price_display: label, is_promotion: false, price_provenance: CANONICAL_PROVENANCE,
})

/** Returns the 9 public price keys. Throws (build stops) on stale or inconsistent verified data: a wrong price must never ship silently. */
export function canonicalPublicPricing(input, { now = new Date(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const status = input.canonical_price_status ?? null
  if (status === 'CONTACT_VERIFIED') return unpriced(CANONICAL_LABEL_CONTACT)
  if (status !== 'PRICE_VERIFIED') return unpriced(CANONICAL_LABEL_UNVERIFIED)
  const regular = vnd(input.regular_price_vnd), promo = vnd(input.promotional_price_vnd), voucher = vnd(input.online_voucher_amount_vnd)
  if (regular === null || [regular, promo, voucher].some(Number.isNaN)) throw new Error('PUBLIC_CANONICAL_PRICE_INVALID')
  if ((promo !== null && promo >= regular) || (voucher !== null && voucher >= (promo ?? regular))) throw new Error('PUBLIC_CANONICAL_PRICE_INVALID')
  const checked = input.canonical_price_checked_at instanceof Date ? input.canonical_price_checked_at.getTime() : Date.parse(input.canonical_price_checked_at ?? '')
  if (!Number.isFinite(checked) || checked > now.getTime() + 5 * 60_000 || now.getTime() - checked > maxAgeMs) throw new Error('PUBLIC_CANONICAL_PRICE_STALE')
  const selling = promo ?? regular
  return {
    price: selling, original_price: promo === null ? null : regular, list_price: regular, sale_price: promo,
    online_discount_amount: voucher,                          // voucher is shown separately and is NEVER deducted from price/list_price
    final_online_price: voucher === null ? null : selling - voucher,
    price_display: null, is_promotion: promo !== null, price_provenance: CANONICAL_PROVENANCE,
  }
}

export function isCanonicalPublicPricing(value) {
  if (!value || typeof value !== 'object') return false
  if (Object.keys(value).length !== CANONICAL_PRICE_KEYS.length || Object.keys(value).some(key => !CANONICAL_PRICE_KEYS.includes(key))) return false
  if (value.price_provenance !== CANONICAL_PROVENANCE) return false
  if (value.price === null) {
    return ['original_price', 'list_price', 'sale_price', 'online_discount_amount', 'final_online_price'].every(key => value[key] === null)
      && [CANONICAL_LABEL_CONTACT, CANONICAL_LABEL_UNVERIFIED].includes(value.price_display) && value.is_promotion === false
  }
  const ok = amount => Number.isSafeInteger(amount) && amount >= 1 && amount <= MAX_VND
  if (!ok(value.price) || !ok(value.list_price) || value.price_display !== null) return false
  if (value.original_price === null ? value.list_price !== value.price : (!ok(value.original_price) || value.original_price !== value.list_price)) return false
  if (value.price > value.list_price) return false
  if (value.sale_price !== (value.price < value.list_price ? value.price : null) || value.is_promotion !== (value.price < value.list_price)) return false
  if (value.online_discount_amount === null) return value.final_online_price === null
  return ok(value.online_discount_amount) && value.online_discount_amount < value.price && value.final_online_price === value.price - value.online_discount_amount
}
