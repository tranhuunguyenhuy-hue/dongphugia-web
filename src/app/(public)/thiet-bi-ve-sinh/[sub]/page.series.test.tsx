import { isValidElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductCard } from '@/components/ui/product-card'
import { ActiveFilters } from '@/components/category/active-filters'
import type { SeriesFacet } from '@/lib/series-facet-contract'
import ListingPage from './page'

const api = vi.hoisted(() => ({
    getSeriesFacet: vi.fn(),
    getPublicProducts: vi.fn(),
    redirect: vi.fn(() => { throw new Error('redirect') }),
}))

vi.mock('next/navigation', () => ({ redirect: api.redirect }))
vi.mock('react-dom', async importOriginal => ({
    ...await importOriginal<typeof import('react-dom')>(),
    preload: vi.fn(),
}))
vi.mock('@/lib/public-api-products', () => ({
    ...api,
    getPublicListingLeaf: async () => ({ id: null, name: 'Vòi chậu' }),
    getPublicListingLeaves: async () => [],
    getAvailableFiltersBySubcategory: async () => ({ brands: [], features: [], materials: [], origins: [] }),
    getListingRuntimeConfig: () => ({ snapshotMode: false }),
}))
vi.mock('@/lib/listing-image-priority', () => ({
    getAboveFoldListingImageSources: () => [],
    shouldPrioritizeListingCard: () => false,
}))

const gf = 'toto-gf-series'
const ge = 'toto-ge-series'
const fixture: SeriesFacet = {
    applicable: true,
    selected: [gf, ge],
    dropped: [],
    options: [
        { slug: gf, name: 'GF Series', count: 9, brandSlug: 'toto', selected: true },
        { slug: ge, name: 'GE Series', count: 2, brandSlug: 'toto', selected: true },
    ],
}

function collectProps(node: ReactNode, component: unknown): Record<string, unknown>[] {
    if (Array.isArray(node)) return node.flatMap(child => collectProps(child, component))
    if (!isValidElement<{ children?: ReactNode }>(node)) return []
    return [
        ...(node.type === component ? [node.props] : []),
        ...collectProps(node.props.children, component),
    ]
}

function listing(searchParams: Record<string, string | string[]>) {
    return ListingPage({ params: Promise.resolve({ sub: 'voi-chau' }), searchParams: Promise.resolve(searchParams) })
}

describe('Vệ sinh series route wiring', () => {
    beforeEach(() => vi.clearAllMocks())

    it('forwards both selected series and the other filters, using each SKU URL for its card', async () => {
        api.getSeriesFacet.mockResolvedValue(fixture)
        const urls = ['/thiet-bi-ve-sinh/voi-chau/sku-xl', '/thiet-bi-ve-sinh/voi-chau/sku-m']
        api.getPublicProducts.mockResolvedValue({
            products: urls.map((url, id) => ({ id, url })), totalPages: 1, total: urls.length,
        })
        const page = await listing({ brand: 'toto', dong: [gf, ge], is_featured: 'true', features: 'gan-tuong' })

        expect(api.getSeriesFacet).toHaveBeenCalledWith('thiet-bi-ve-sinh', 'voi-chau', ['toto'], [gf, ge], { featured: true })
        expect(api.getPublicProducts).toHaveBeenCalledWith(expect.objectContaining({
            subcategory_slugs: 'voi-chau', brand_slug: 'toto', series_slugs: [gf, ge],
            is_featured: true, feature_slugs: 'gan-tuong',
        }))
        expect(collectProps(page, ProductCard).map(card => card.href)).toEqual(urls)
        expect(collectProps(page, ActiveFilters)[0]?.seriesFacet).toBe(fixture)
    })

    it('cleans an incompatible tag from a deep link while keeping valid filters', async () => {
        api.getSeriesFacet.mockResolvedValue({ ...fixture, selected: [gf], dropped: ['inax-s600-line'] })
        await expect(listing({
            brand: 'toto', dong: [gf, 'inax-s600-line'], is_featured: 'true', sort: 'newest', page: '3',
        })).rejects.toThrow('redirect')
        expect(api.redirect).toHaveBeenCalledWith(
            '/thiet-bi-ve-sinh/voi-chau?brand=toto&is_featured=true&sort=newest&dong=toto-gf-series',
        )
        expect(api.getPublicProducts).not.toHaveBeenCalled()
    })
})
