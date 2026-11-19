import { afterEach, describe, expect, it, vi } from 'vitest'

const rows = vi.hoisted(() => ({ value: [] as unknown[], fail: false, statements: [] as string[] }))
vi.mock('./public-db', () => ({
  publicPostgresEnabled: () => process.env.PUBLIC_CATALOGUE_SOURCE === 'postgresql',
  readPublicRows: async (statement: string) => { rows.statements.push(statement); if (rows.fail) throw new Error('permission denied'); return rows.value },
}))
vi.mock('./preview-public-catalogue', () => ({ getPreviewCatalogueCategories: async () => [], getPreviewCatalogueProducts: async () => [], PUBLIC_CATALOGUE_FIXTURE_NOTICE: 'x' }))
vi.mock('./public-snapshot-catalogue', () => ({ readSnapshotManifest: async () => ({ checkpoint: 'a'.repeat(40) }) }))
vi.mock('./legacy-blog', () => ({ historicalBlogImage: (url: string) => url }))
vi.mock('./live-public-blog', () => ({ getPublicBlogPosts: async () => [] }))

import { getPublicHomeBanners } from './preview-public-home'

afterEach(() => { vi.unstubAllEnvs(); rows.value = []; rows.fail = false; rows.statements = [] })

describe('hero banners read from the Production table', () => {
  const production = () => { vi.stubEnv('APP_ENV', 'production'); vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', 'postgresql') }

  it('serves active HERO rows from PostgreSQL, ordered by the Admin sort order, with a fixed read-only query', async () => {
    production()
    rows.value = [
      { id: 21, title: 'A', image_url: 'https://dpg-products.b-cdn.net/banners/1776486977694-87cnaa.png', link_url: null },
      { id: 22, title: 'B', image_url: 'https://dpg-products.b-cdn.net/banners/1776485447824-r0eml8.png', link_url: '/blog' },
    ]
    expect((await getPublicHomeBanners()).map(({ id }) => id)).toEqual([21, 22])
    expect(rows.statements).toHaveLength(1)
    expect(rows.statements[0]).toMatch(/^\s*SELECT\b/)
    expect(rows.statements[0]).toContain("is_active = true AND position = 'HERO' ORDER BY sort_order, id")
  })

  it('falls back to the verified historical hero when the table is empty, unreadable, or holds only unsafe rows', async () => {
    production()
    rows.value = []
    expect((await getPublicHomeBanners()).map(({ id }) => id)).toEqual([6, 4, 5])
    rows.value = [{ id: 31, title: 'x', image_url: 'https://evil.example/banners/a.png', link_url: null }]
    expect((await getPublicHomeBanners()).map(({ id }) => id)).toEqual([6, 4, 5])
    rows.fail = true
    expect((await getPublicHomeBanners()).map(({ id }) => id)).toEqual([6, 4, 5])
  })

  it('never queries outside Production postgresql mode', async () => {
    vi.stubEnv('APP_ENV', 'production'); vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', 'snapshot'); vi.stubEnv('PUBLIC_CATALOGUE_CHECKPOINT', 'a'.repeat(40))
    expect((await getPublicHomeBanners()).map(({ id }) => id)).toEqual([6, 4, 5])
    expect(rows.statements).toHaveLength(0)
  })
})
