import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./public-db', () => ({ publicPostgresEnabled: () => process.env.PUBLIC_CATALOGUE_SOURCE === 'postgresql' }))
vi.mock('./preview-public-catalogue', () => ({
  getPreviewCatalogueCategories: async () => [],
  getPreviewCatalogueProducts: async () => [],
  PUBLIC_CATALOGUE_FIXTURE_NOTICE: 'Fixture only',
}))
vi.mock('./public-snapshot-catalogue', () => ({ readSnapshotManifest: async () => ({ checkpoint: 'a'.repeat(40) }) }))
vi.mock('./legacy-blog', () => ({ historicalBlogImage: (url: string) => url }))
vi.mock('./live-public-blog', () => ({ getPublicBlogPosts: async () => Array.from({ length: 10 }, (_, id) => ({
  id, title: `Post ${id}`, slug: `post-${id}`, excerpt: 'Public', thumbnail_url: '/image.jpg',
  published_at: '2026-11-15', category: { name: 'Category', slug: 'category' },
})) }))

import { getPublicHomeBanners, getPublicHomeContent } from './preview-public-home'

afterEach(() => vi.unstubAllEnvs())

describe('fixed staging homepage parity', () => {
  it('serves the same three artworks and first three Blog posts from a pinned snapshot', async () => {
    vi.stubEnv('APP_ENV', 'production')
    vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', 'snapshot')
    vi.stubEnv('PUBLIC_CATALOGUE_CHECKPOINT', 'a'.repeat(40))
    const banners = await getPublicHomeBanners()
    const production = await getPublicHomeContent()
    vi.stubEnv('APP_ENV', 'staging')
    expect(await getPublicHomeBanners()).toEqual(banners)
    expect(banners.map(({ id }) => id)).toEqual([6, 4, 5])
    const staging = await getPublicHomeContent()
    expect(staging.posts).toEqual(production.posts)
    expect(staging.posts).toHaveLength(3)
    expect(staging.previewNotice).toContain('chỉ đọc')
    expect(staging.previewNotice).not.toContain('Fixture')
  })

  it.each(['snapshot', 'production-published-snapshot', 'postgresql'])(
    'does not expose homepage parity on an unpinned %s candidate', async (source) => {
      vi.stubEnv('APP_ENV', 'staging')
      vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', source)
      vi.stubEnv('PUBLIC_CATALOGUE_CHECKPOINT', '')
      expect(await getPublicHomeBanners()).toEqual([])
      expect((await getPublicHomeContent()).posts).toEqual([])
    },
  )

  it.each(['production-published-snapshot', 'postgresql'])(
    'rejects homepage parity for a pinned %s source', async (source) => {
      vi.stubEnv('APP_ENV', 'staging')
      vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', source)
      vi.stubEnv('PUBLIC_CATALOGUE_CHECKPOINT', 'a'.repeat(40))
      expect(await getPublicHomeBanners()).toEqual([])
      expect((await getPublicHomeContent()).posts).toEqual([])
    },
  )

  it('keeps local fixture previews restricted even with a checkpoint', async () => {
    vi.stubEnv('APP_ENV', 'preview')
    vi.stubEnv('PUBLIC_CATALOGUE_CHECKPOINT', 'a'.repeat(40))
    vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', 'snapshot')
    expect(await getPublicHomeBanners()).toEqual([])
    expect((await getPublicHomeContent()).posts).toEqual([])
  })
})
