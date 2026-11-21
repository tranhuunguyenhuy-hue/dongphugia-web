// #432 — "Dòng sản phẩm" (manufacturer series) facet contract. Pure types + helpers, no DB/Prisma.
// Shared by the Public runtime (apps/public/src/runtime) and the UI (#433). One level of series only.
// A series tag exists only for SKUs whose exact code is listed by the manufacturer (evidence matrix #431);
// PENDING SKUs have no tag, but always stay in the default listing.

export const SERIES_QUERY_PARAM = 'dong'
export const MAX_SELECTED_SERIES = 16
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type SeriesFacetOption = {
  /** Stable URL value, namespaced by brand, e.g. `toto-gf-series`. */
  slug: string
  /** Official brand name, e.g. `GF Series`, `S600 LINE`. */
  name: string
  brandSlug: string
  /** Number of real public SKUs in the current context (category/listing ∩ selected brands ∩ featured). */
  count: number
  selected: boolean
}

export type SeriesFacet = {
  /** false when no brand is selected, or no verified series has a public SKU in the context → UI hides the facet. */
  applicable: boolean
  options: SeriesFacetOption[]
  /** Selected tags that are still valid in this context. */
  selected: string[]
  /** Selected tags that must be removed from the URL (other brand / no SKU left / malformed). */
  dropped: string[]
}

/** Parse `?dong=a,b` (string or repeated keys) into unique, well-formed slugs. Malformed values are returned in `invalid`. */
export function parseSeriesParam(raw: string | readonly string[] | undefined): { slugs: string[]; invalid: string[] } {
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
    .map((v) => v.trim()).filter(Boolean)
  const slugs: string[] = []
  const invalid: string[] = []
  for (const part of parts) {
    if (!SLUG.test(part) || part.length > 80 || slugs.length >= MAX_SELECTED_SERIES) { invalid.push(part); continue }
    if (!slugs.includes(part)) slugs.push(part)
  }
  return { slugs, invalid }
}

export function seriesBelongsToBrands(seriesSlug: string, brandSlugs: readonly string[]): boolean {
  return brandSlugs.some((brand) => seriesSlug.startsWith(`${brand}-`))
}

/** Series are only meaningful together with a brand; a tag whose brand is not selected is dropped (brand change resets it). */
export function normalizeSeriesSelection(brandSlugs: readonly string[], seriesSlugs: readonly string[]): { accepted: string[]; dropped: string[] } {
  if (brandSlugs.length === 0) return { accepted: [], dropped: [...seriesSlugs] }
  const accepted: string[] = []
  const dropped: string[] = []
  for (const slug of seriesSlugs) (seriesBelongsToBrands(slug, brandSlugs) ? accepted : dropped).push(slug)
  return { accepted, dropped }
}

/** Variant groups reviewed as wrong in #431 (D5). Siblings are never built from them until a human review fixes the data. */
export const QUARANTINED_VARIANT_GROUPS: readonly string[] = [
  'TBW0', 'TBW01001B', 'TBG02302', 'TBG08302', 'TLG0830', 'CW812RA#W/TC', 'CW822RA#W/TC',
]
/** Safety cap for PDP siblings (the previous hard LIMIT 8 truncated groups of 14–20 SKUs). */
export const VARIANT_SIBLING_CAP = 60
