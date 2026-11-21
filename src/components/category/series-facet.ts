export type SeriesFacetOption = {
    slug: string
    name: string
    brandSlug: string
    count: number
}

export type SeriesFacet = {
    queryKey: string
    // Contextual counts come from the catalogue. Active options may have a zero count.
    options: readonly SeriesFacetOption[]
}

export function retainSeriesForBrands(
    params: URLSearchParams,
    facet: SeriesFacet,
    brandSlugs: readonly string[],
) {
    const selected = params.get(facet.queryKey)?.split(',') ?? []
    const allowed = new Set(facet.options
        .filter(option => brandSlugs.includes(option.brandSlug))
        .map(option => option.slug))
    const retained = selected.filter(slug => allowed.has(slug))
    if (retained.length) params.set(facet.queryKey, retained.join(','))
    else params.delete(facet.queryKey)
}
