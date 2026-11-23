// Marketing/click identifiers and Next/vinext transport parameters never change catalogue content.
// A listing page must ignore them instead of returning 404 (Facebook adds fbclid, Google Ads adds
// gclid, campaigns add utm_*). Any other unknown key is still rejected so filters that the server
// cannot honour never produce misleading results.
const TRACKING_KEYS = new Set(['_rsc', 'fbclid', 'gclid'])

export function isTrackingQueryKey(key: string) {
  return TRACKING_KEYS.has(key) || key.startsWith('utm_')
}

type ListingQuery = Record<string, string | string[] | undefined>

export function resolveListingQuery<T extends ListingQuery>(
  query: T,
  supportedKeys: readonly string[],
): { ok: true; query: T } | { ok: false } {
  const result: ListingQuery = {}
  for (const [key, value] of Object.entries(query)) {
    if (isTrackingQueryKey(key)) continue
    if (!supportedKeys.includes(key)) return { ok: false }
    result[key] = value
  }
  return { ok: true, query: result as T }
}

// #447: price sorting exists in the listing UI and in the live query (promotional ?? regular price, NULL last), but the Public
// route used to reject `?sort=` for every category (404 on Staging and Production alike), so the control had no effect.
// It is accepted ONLY for thiet-bi-ve-sinh on the isolated TEST Preview; every other environment/category is unchanged.
const BASE_LISTING_KEYS = ['page', 'brand', 'dong', 'is_featured'] as const
export const LISTING_SORT_VALUES = ['default', 'price-asc', 'price-desc'] as const

type ListingEnv = { APP_ENV?: string; PREVIEW_TEST_DATABASE_ISOLATED?: string }

export function supportedListingKeys(categorySlug: string, env: ListingEnv = process.env): readonly string[] {
  const sortEnabled = categorySlug === 'thiet-bi-ve-sinh' && env.APP_ENV === 'staging' && env.PREVIEW_TEST_DATABASE_ISOLATED === 'true'
  return sortEnabled ? [...BASE_LISTING_KEYS, 'sort'] : BASE_LISTING_KEYS
}

export function isSupportedListingSort(value: unknown): boolean {
  return typeof value === 'string' && (LISTING_SORT_VALUES as readonly string[]).includes(value)
}
