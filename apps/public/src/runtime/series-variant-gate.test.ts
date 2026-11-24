import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ readPublicRows: vi.fn(), publicPostgresEnabled: vi.fn(() => true) }))
vi.mock('./public-db', () => ({ readPublicRows: mocks.readPublicRows, publicPostgresEnabled: mocks.publicPostgresEnabled }))

// #470 / scope lock #443: series filter + variant selector (#432/#433/#440) are not accepted -> OFF in Production (no query, no render input).
const sqlAll = () => mocks.readPublicRows.mock.calls.map(c => String(c[0])).join('\n')
const load = async () => { vi.resetModules(); return { live: await import('./live-public-catalogue'), api: await import('./canonical-public-api') } }
beforeEach(() => { mocks.readPublicRows.mockReset(); mocks.readPublicRows.mockResolvedValue([]); vi.unstubAllEnvs() })

describe('series/variant gate — Production default OFF', () => {
    beforeEach(() => { vi.stubEnv('APP_ENV', 'production') })
    it('live layer: siblings and series facet issue NO query', async () => {
        const { live } = await load()
        expect(await live.getLiveVariantSiblings('G1', 1)).toEqual([])
        expect(await live.getLiveSeriesFacet('thiet-bi-ve-sinh', 'chau', ['toto'], ['toto-x'])).toEqual({ applicable: false, options: [], selected: [], dropped: ['toto-x'] })
        expect(mocks.readPublicRows).not.toHaveBeenCalled()
    })
    it('listing statement never references the series spec tables, even when the caller passes series slugs (direct URL/API)', async () => {
        const { live } = await load()
        await live.getLiveListing('thiet-bi-ve-sinh', 'chau', 1, 48, { brandSlugs: ['toto'], seriesSlugs: ['toto-x'] })
        const sql = sqlAll()
        expect(sql).not.toMatch(/spec_definitions|spec_options|product_spec_values|so\.slug|sd\.key/)
        expect(mocks.readPublicRows.mock.calls[0][1][6]).toEqual([])     // series parameter is empty
    })
    it('API layer: ?dong= / series_slugs ignored, facet none, selection data empty — zero queries for siblings/series', async () => {
        const { api } = await load()
        await api.getPublicProducts({ category_slug: 'thiet-bi-ve-sinh', subcategory_slugs: 'chau', brand_slug: 'toto', series_slugs: 'toto-x', pageSize: 24 } as never)
        expect(sqlAll()).not.toMatch(/spec_definitions|spec_options|product_spec_values/)
        mocks.readPublicRows.mockClear()
        expect(await api.getSeriesFacet('thiet-bi-ve-sinh', 'chau', ['toto'], ['toto-x'])).toMatchObject({ applicable: false, selected: [], dropped: ['toto-x'] })
        expect(await api.getVariantSelectionData('G1', 1)).toEqual({ axes: [], currentVariantOptions: [], siblings: [] })
        expect(await api.getVariantSiblings('G1', 1)).toEqual([])
        expect(mocks.readPublicRows).not.toHaveBeenCalled()
    })
    it('explicit PUBLIC_SERIES_VARIANT=on restores the accepted-later behaviour', async () => {
        vi.stubEnv('PUBLIC_SERIES_VARIANT', 'on')
        const { live } = await load()
        await live.getLiveVariantSiblings('G1', 1); await live.getLiveSeriesFacet('thiet-bi-ve-sinh', 'chau', ['toto'])
        expect(mocks.readPublicRows).toHaveBeenCalledTimes(2)
        mocks.readPublicRows.mockClear()
        await live.getLiveListing('thiet-bi-ve-sinh', 'chau', 1, 48, { brandSlugs: ['toto'], seriesSlugs: ['toto-x'] })
        expect(sqlAll()).toContain('spec_options')
    })
})

describe('series/variant gate — other environments unchanged', () => {
    it.each(['staging', 'preview', undefined])('APP_ENV=%s keeps series/variants enabled', async env => {
        if (env) vi.stubEnv('APP_ENV', env)
        const { live } = await load()
        await live.getLiveVariantSiblings('G1', 1)
        expect(mocks.readPublicRows).toHaveBeenCalledTimes(1)
    })
})
