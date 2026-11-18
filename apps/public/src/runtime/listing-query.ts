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
