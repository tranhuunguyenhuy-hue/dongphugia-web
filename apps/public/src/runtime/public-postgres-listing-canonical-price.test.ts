import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// #470: with PUBLIC_CANONICAL_PRICING=on the live PostgreSQL mapper yields priced / canonical-unpriced cards. The shard projection used a fixed
// field list that dropped the six restored price keys, so isPublicSnapshotListingProduct rejected every priced card (and every canonical
// "Cần liên hệ xác nhận giá" card) and the listing API answered 503. Found by the packaged verify of the Production release lane.
const mocks = vi.hoisted(() => ({ listing: vi.fn() }))
vi.mock('./live-public-catalogue', () => ({ getLiveListing: mocks.listing }))
vi.mock('./public-snapshot-mode', () => ({ publicSnapshotCheckpoint: () => 'a'.repeat(40) }))
vi.mock('./public-snapshot-catalogue', () => ({ getSnapshotProducts: vi.fn(), readSnapshotManifest: vi.fn() }))
import { getPublicSnapshotListingShard } from './public-snapshot-listing'
import { publicListingCache } from './public-listing-cache'

const card = (over: Record<string, unknown>) => ({
  id: 7, name: 'Public product', display_name: 'Public product', slug: 'product-7', sku: 'SKU-7', stock_status: 'contact', image_main_url: null,
  is_active: true, is_featured: false, variant_options: [], categories: { name: 'Thiết bị vệ sinh', slug: 'thiet-bi-ve-sinh' },
  subcategories: { name: 'Bồn Cầu', slug: 'bon-cau' }, brands: { name: 'TOTO', slug: 'toto' },
  canonical_category_slug: 'thiet-bi-ve-sinh', canonical_subcategory_slug: 'bon-cau', url: '/thiet-bi-ve-sinh/bon-cau/product-7', ...over,
})
const priced = card({ price: 21223200, price_display: null, is_promotion: true, original_price: 26529000, list_price: 26529000, sale_price: 21223200,
  online_discount_amount: 2652900, final_online_price: 18570300, price_provenance: 'hita-exact-v1' })
const unpriced = card({ id: 8, slug: 'product-8', sku: 'SKU-8', url: '/thiet-bi-ve-sinh/bon-cau/product-8', price: null, price_display: 'Cần liên hệ xác nhận giá', is_promotion: false, original_price: null,
  list_price: null, sale_price: null, online_discount_amount: null, final_online_price: null, price_provenance: 'hita-exact-v1' })
const legacyOther = card({ id: 9, slug: 'product-9', sku: 'SKU-9', url: '/thiet-bi-ve-sinh/bon-cau/product-9', price: null, price_display: 'Liên hệ báo giá', is_promotion: false })

describe('#470 PostgreSQL listing shard keeps the canonical price fields', () => {
  afterEach(() => { vi.unstubAllEnvs(); publicListingCache.clear() })
  beforeEach(() => { vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', 'postgresql'); publicListingCache.clear() })
  it('serves priced and canonical-unpriced cards (previously a 503) and keeps other cards untouched', async () => {
    mocks.listing.mockReset().mockResolvedValue({ products: [priced, unpriced, legacyOther], totalCount: 3, page: 1 })
    const shard = await getPublicSnapshotListingShard('thiet-bi-ve-sinh', 'bon-cau', 1)
    expect(shard!.products.map((p) => p.price)).toEqual([21223200, null, null])
    expect(shard!.products[0]).toMatchObject({ list_price: 26529000, sale_price: 21223200, online_discount_amount: 2652900, final_online_price: 18570300, price_provenance: 'hita-exact-v1' })
    expect(shard!.products[1]).toMatchObject({ price_display: 'Cần liên hệ xác nhận giá', price_provenance: 'hita-exact-v1' })
    expect(Object.keys(shard!.products[2])).not.toContain('price_provenance')   // rows outside the canonical scope are projected exactly as before
  })
})
