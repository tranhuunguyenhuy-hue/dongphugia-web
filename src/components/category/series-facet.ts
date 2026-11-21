import { parseSeriesParam, SERIES_QUERY_PARAM, type SeriesFacet } from '@/lib/series-facet-contract'

export function retainSeriesForBrands(
    params: URLSearchParams,
    facet: SeriesFacet,
    brandSlugs: readonly string[],
) {
    const selected = parseSeriesParam(params.getAll(SERIES_QUERY_PARAM)).slugs
    const allowed = new Set(facet.options
        .filter(option => brandSlugs.includes(option.brandSlug))
        .map(option => option.slug))
    const retained = selected.filter(slug => allowed.has(slug))
    if (retained.length) params.set(SERIES_QUERY_PARAM, retained.join(','))
    else params.delete(SERIES_QUERY_PARAM)
}
