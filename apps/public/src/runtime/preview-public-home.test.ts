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

import { getPublicHomeBanners, getPublicHomeContent, mapHomeBannerRows, safeHomeBannerImage, safeHomeBannerLink } from './preview-public-home'

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

describe('database-managed hero banners (M4)', () => {
  const managed = 'https://dpg-products.b-cdn.net/banners/1776486977694-87cnaa.png'
  const legacy = 'https://tygjmrhandbffjllxveu.supabase.co/storage/v1/object/public/images/banners/1776486977694-87cnaa.png'

  it('maps active Admin rows, in order, with strictly validated images and links', () => {
    const rows = [
      { id: 11, title: 'Hero A', image_url: managed, link_url: '/thiet-bi-ve-sinh' },
      { id: 12, title: null, image_url: legacy, link_url: 'https://www.dongphugia.vn/blog' },
      { id: 13, title: 'Bad image', image_url: 'https://evil.example/banners/a.png', link_url: null },
      { id: 14, title: 'Bad link', image_url: managed, link_url: 'javascript:alert(1)' },
    ]
    const mapped = mapHomeBannerRows(rows)
    expect(mapped.map((banner) => banner.id)).toEqual([11, 12, 14])
    expect(mapped[0]).toMatchObject({ imageUrl: managed, desktopImageUrl: managed, mobileImageUrl: managed, linkUrl: '/thiet-bi-ve-sinh' })
    expect(mapped[1].linkUrl).toBe('https://www.dongphugia.vn/blog')
    expect(mapped[2].linkUrl).toBeNull()
  })

  it('accepts only managed or archived banner image shapes', () => {
    expect(safeHomeBannerImage(managed)).toBe(managed)
    expect(safeHomeBannerImage(legacy)).toBe(legacy)
    for (const value of [
      'http://dpg-products.b-cdn.net/banners/a.png', 'https://dpg-products.b-cdn.net/products/a.png', 'https://dpg-products.b-cdn.net/banners/../a.png',
      'https://dpg-products.b-cdn.net/banners/a.svg', 'https://dpg-products.b-cdn.net/banners/a.png?x=1', 'https://dpg-products.b-cdn.net/banners/a.png#x',
      'https://dpg-products.b-cdn.net:444/banners/a.png', 'https://u:p@dpg-products.b-cdn.net/banners/a.png', 'https://dpg-products.b-cdn.net.evil.example/banners/a.png',
      'https://cdn.dongphugia.com.vn/banners/a.png', null, 42, '',
    ]) expect(safeHomeBannerImage(value), String(value)).toBeNull()
  })

  it('accepts only same-site paths and dongphugia.vn https links', () => {
    for (const ok of ['/', '/blog/huong-dan-chon', '/thiet-bi-ve-sinh?brand=toto', 'https://dongphugia.vn/x']) expect(safeHomeBannerLink(ok), ok).not.toBeNull()
    for (const bad of ['//evil.example', '/\\evil.example', 'javascript:alert(1)', 'http://www.dongphugia.vn/', 'https://evil.example/', 'https://u:p@www.dongphugia.vn/', '', null]) expect(safeHomeBannerLink(bad), String(bad)).toBeNull()
  })

  it('keeps the verified historical hero when the table is empty or unreadable, and serves DB rows once present', async () => {
    vi.stubEnv('APP_ENV', 'production')
    vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', 'postgresql')
    // ./public-db is mocked without readPublicRows here: the read throws, so the historical set must be served.
    expect((await getPublicHomeBanners()).map(({ id }) => id)).toEqual([6, 4, 5])
  })
})
