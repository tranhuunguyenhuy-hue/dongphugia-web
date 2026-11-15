import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ listing: vi.fn() }))
vi.mock('./live-public-catalogue', () => ({ getLiveListing: mocks.listing }))
vi.mock('./public-snapshot-mode', () => ({ publicSnapshotCheckpoint: () => 'a'.repeat(40) }))
vi.mock('./public-snapshot-catalogue', () => ({ getSnapshotProducts: vi.fn(), readSnapshotManifest: vi.fn() }))
import { getPublicSnapshotListingShard } from './public-snapshot-listing'
import { publicListingCache } from './public-listing-cache'
const product = {id:7,name:'Public product',display_name:'Public product',slug:'product-7',sku:'SKU-7',price:null,price_display:'Liên hệ báo giá',stock_status:'contact',image_main_url:null,is_active:true,is_featured:false,is_promotion:false,variant_options:[],categories:{name:'Vệ sinh',slug:'thiet-bi-ve-sinh'},subcategories:{name:'Bồn cầu',slug:'bon-cau'},brands:null,canonical_category_slug:'thiet-bi-ve-sinh',canonical_subcategory_slug:'bon-cau',url:'/thiet-bi-ve-sinh/bon-cau/product-7'}
describe('PostgreSQL-backed shard reuse', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); publicListingCache.clear() })
  beforeEach(() => {
    vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', 'postgresql')
    publicListingCache.clear()
    mocks.listing.mockReset().mockResolvedValue({products:[product],totalCount:1,page:1})
  })
  it('does not repeat SQL on refresh and does not share mutable response objects', async () => {
    const first = await getPublicSnapshotListingShard('thiet-bi-ve-sinh','bon-cau',1)
    first!.products[0].name = 'mutated by caller'
    const again = await getPublicSnapshotListingShard('thiet-bi-ve-sinh','bon-cau',1)
    expect(again!.products[0].name).toBe('Public product')
    expect(mocks.listing).toHaveBeenCalledOnce()
  })
  it('reads PostgreSQL again after the fixed freshness deadline', async () => {
    vi.useFakeTimers()
    await getPublicSnapshotListingShard('thiet-bi-ve-sinh','bon-cau',1)
    vi.advanceTimersByTime(30_000)
    mocks.listing.mockResolvedValue({products:[{...product,name:'Fresh DB value'}],totalCount:1,page:1})
    expect((await getPublicSnapshotListingShard('thiet-bi-ve-sinh','bon-cau',1))!.products[0].name).toBe('Fresh DB value')
    expect(mocks.listing).toHaveBeenCalledTimes(2)
  })
  it('does not cache database failures', async () => {
    mocks.listing.mockRejectedValueOnce(new Error('Query read timeout'))
    await expect(getPublicSnapshotListingShard('thiet-bi-ve-sinh','bon-cau',1)).rejects.toThrow('Query read timeout')
    await expect(getPublicSnapshotListingShard('thiet-bi-ve-sinh','bon-cau',1)).resolves.toMatchObject({totalCount:1})
    expect(mocks.listing).toHaveBeenCalledTimes(2)
  })
})
