import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ readPublicRows: vi.fn(), publicPostgresEnabled: vi.fn(() => true) }))
vi.mock('./public-db', () => ({ readPublicRows: mocks.readPublicRows, publicPostgresEnabled: mocks.publicPostgresEnabled }))

// #457: a preload is useful only if it issues byte-identical (statement, values) to the template's later call;
// the request-scoped memo in public-db.ts then serves the template from the in-flight read.
const calls = () => mocks.readPublicRows.mock.calls.map(([statement, values]) => JSON.stringify([statement, values]))
const load = async () => {
  vi.resetModules()
  return { preload: await import('./public-route-preload'), api: await import('./canonical-public-api') }
}

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv('APP_ENV', 'production')
  vi.stubEnv('PUBLIC_CANONICAL_PRICING', 'on')
  vi.stubEnv('PUBLIC_CANONICAL_PRICE_BRANDS', 'toto,inax')
  mocks.readPublicRows.mockReset().mockResolvedValue([])
  mocks.publicPostgresEnabled.mockReset().mockReturnValue(true)
})

describe('route preload (#457)', () => {
  it('PDP: product and related reads equal the template calls', async () => {
    const { preload, api } = await load()
    preload.preloadProductRoute('thiet-bi-ve-sinh', 'bon-cau', 'bon-cau-toto-ms636dt2')
    const preloaded = calls()
    expect(preloaded).toHaveLength(2)
    mocks.readPublicRows.mockClear()
    await api.getPublicProductBySlug('thiet-bi-ve-sinh', 'bon-cau-toto-ms636dt2')
    await api.getPublicProducts({ category_slug: 'thiet-bi-ve-sinh', subcategory_slug: 'bon-cau', page: 1, pageSize: 5 })
    expect(calls()).toEqual(preloaded)
  })

  it.each(Object.entries({ 'thiet-bi-ve-sinh': 12, 'thiet-bi-bep': 24 }))('listing %s: unfiltered page-1 reads equal the template calls', async (category, pageSize) => {
    const { preload, api } = await load()
    preload.preloadListingRoute(category, 'bon-cau', true)
    const preloaded = calls()
    expect(preloaded).toHaveLength(4)
    mocks.readPublicRows.mockClear()
    const { getLiveListingRouteMetadata } = await import('./live-public-catalogue')
    await getLiveListingRouteMetadata(category, 'bon-cau')
    await api.getAvailableFiltersBySubcategory('bon-cau', undefined, category)   // brands + leaves
    await api.getPublicProducts({ category_slug: category, subcategory_slugs: 'bon-cau', page: 1, pageSize, sortBy: 'sort_order', sortDir: 'asc' })
    for (const call of preloaded) expect(calls()).toContain(call)
  })

  it('filtered listing preloads no product page; invalid slugs and snapshot mode preload nothing', async () => {
    const { preload } = await load()
    preload.preloadListingRoute('thiet-bi-ve-sinh', 'bon-cau', false)
    expect(calls()).toHaveLength(3)
    mocks.readPublicRows.mockClear()
    preload.preloadProductRoute('thiet-bi-ve-sinh', 'bon-cau', 'Bad.Slug')
    preload.preloadListingRoute('khac', 'bon-cau', true)
    mocks.publicPostgresEnabled.mockReturnValue(false)
    preload.preloadProductRoute('thiet-bi-ve-sinh', 'bon-cau', 'ok')
    expect(mocks.readPublicRows).not.toHaveBeenCalled()
  })

  it('a failed preload is swallowed (no unhandled rejection)', async () => {
    mocks.readPublicRows.mockRejectedValue(new Error('Query read timeout'))
    const { preload } = await load()
    preload.preloadProductRoute('thiet-bi-ve-sinh', 'bon-cau', 'ok')
    await new Promise(resolve => setTimeout(resolve, 0))
  })
})
