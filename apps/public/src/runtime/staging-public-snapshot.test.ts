import { afterEach, expect, it, vi } from 'vitest'
import { buildM2PublicSnapshot, type PublicCapture } from '../../../../scripts/app-foundation/m2-public-snapshot.mjs'
import { mapLiveProduct } from './live-public-catalogue'
import { blogCategories, blogPosts } from './legacy-blog'

const mocks = vi.hoisted(() => ({ assets: vi.fn(), sql: vi.fn() }))
vi.mock('cloudflare:workers', () => ({ env: { ASSETS: { fetch: mocks.assets } } }))
vi.mock('./public-db', () => ({ publicPostgresEnabled: () => false, readPublicRows: mocks.sql }))
import { getPublicBlogCategories, getPublicBlogPosts, mapPublicBlogRecords } from './live-public-blog'
import { getPublicProducts, getListingRuntimeConfig, getPublicProductBySlug } from './canonical-public-api'
import { getPublicSnapshotListingShard } from './public-snapshot-listing'
import { getSnapshotProduct, getSnapshotVariantSiblings } from './public-snapshot-catalogue'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); mocks.assets.mockReset(); mocks.sql.mockReset() })

it('serves all ten Blog posts and rich PDPs from the pinned ASSETS binding with no SQL or Production fetch', async () => {
  const roots = ['thiet-bi-ve-sinh', 'thiet-bi-bep', 'vat-lieu-nuoc', 'gach-op-lat']
  const entries = roots.map((root, index) => {
    const card = mapLiveProduct({ id: index + 1, sku: `SKU-${index}`, name: 'Public', display_name: null, slug: `public-${index}`,
      description: 'Public text', image_main_url: null, is_featured: true, variant_group: null, variant_type: null, variant_label: null,
      category_name: root, category_slug: root, listing_name: 'Listing', listing_slug: 'listing', brand_name: null, brand_slug: null })
    return { product: { ...card, publicContent: { ...card.publicContent!, descriptionHtml: '<p>Fresh captured PDP</p>' } }, card,
      listed: true, searchable: true, priority: 0, order: index }
  })
  const capture: PublicCapture = { sourceSha: 'a'.repeat(40), productionSourceSha: 'b'.repeat(40), capturedAt: '2026-11-15T16:00:00.000Z', entries,
    categories: roots.map(root => ({ category_slug: root, category_name: root, listing_slug: 'listing', listing_name: 'Listing', total_count: 1 })),
    posts: mapPublicBlogRecords(blogPosts.map(post => ({ post, category: post.category }))), blogCategories }
  const snapshot = buildM2PublicSnapshot(capture)
  const files = new Map(snapshot.files.map(f => [f.name, f.body]))
  const network = vi.fn().mockRejectedValue(new Error('No runtime network allowed'))
  vi.stubGlobal('fetch', network)
  vi.stubEnv('APP_ENV', 'staging'); vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', 'snapshot')
  vi.stubEnv('PREVIEW_NOINDEX', 'true'); vi.stubEnv('PUBLIC_CATALOGUE_CHECKPOINT', snapshot.checkpoint)
  mocks.assets.mockImplementation(async (url: string) => {
    const body = files.get(new URL(url).pathname.replace('/__catalogue/v1/', ''))
    return new Response(body ?? null, { status: body ? 200 : 404 })
  })
  const posts = await getPublicBlogPosts()
  expect(posts).toHaveLength(10)
  expect(posts[0]).not.toHaveProperty('publishing_identity_id')
  expect(await getPublicBlogCategories()).toEqual(blogCategories)
  expect((await getSnapshotProduct('thiet-bi-ve-sinh', 'listing', 'public-0'))?.publicContent?.descriptionHtml).toBe('<p>Fresh captured PDP</p>')
  expect(await getSnapshotVariantSiblings('public-999', 1)).toEqual([])
  const shard = await getPublicSnapshotListingShard('thiet-bi-ve-sinh', 'listing', 1)
  expect(shard?.products).toHaveLength(1)
  expect(shard?.products[0]).not.toHaveProperty('publicContent')
  mocks.assets.mockClear()
  expect(getListingRuntimeConfig('thiet-bi-ve-sinh', 'listing')).toMatchObject({ snapshotMode: false, hideUnverifiedCommercialFilters: true })
  const serverPage = await getPublicProducts({ category_slug: 'thiet-bi-ve-sinh', subcategory_slugs: 'listing', page: 1, pageSize: 24 })
  expect(serverPage.products).toHaveLength(1)
  expect(mocks.assets.mock.calls.some(([url]) => String(url).includes('/listing-index/'))).toBe(true)
  expect(mocks.assets.mock.calls.some(([url]) => String(url).includes('/listings/'))).toBe(false)
  const pdp = await getPublicProductBySlug('thiet-bi-ve-sinh', 'public-0')
  expect(pdp?.description).toContain('Fresh captured PDP')
  expect(mocks.assets.mock.calls.some(([url]) => String(url).includes('/routes/'))).toBe(true)
  expect(network).not.toHaveBeenCalled()
  expect(mocks.sql).not.toHaveBeenCalled()
  files.delete('blog.json')
  await expect(getPublicBlogPosts()).rejects.toThrow()
})
