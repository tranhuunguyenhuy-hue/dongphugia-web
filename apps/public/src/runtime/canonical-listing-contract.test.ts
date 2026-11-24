import { describe, expect, it } from 'vitest'
import { isPublicSnapshotListingProduct } from './snapshot-listing-contract'

// #470: the runtime listing validator must accept the Production canonical DTO (provenance hita-exact-v1) and still reject tampering.
const base = {
    id: 1, name: 'A', display_name: 'A', slug: 'a', sku: 'SKU-A', stock_status: 'contact', image_main_url: null, is_active: true, is_featured: false,
    variant_options: [], categories: { name: 'Thiết bị vệ sinh', slug: 'thiet-bi-ve-sinh' }, subcategories: { name: 'Chậu', slug: 'chau' }, brands: { name: 'TOTO', slug: 'toto' },
    canonical_category_slug: 'thiet-bi-ve-sinh', canonical_subcategory_slug: 'chau', url: '/thiet-bi-ve-sinh/chau/a',
}
const priced = { ...base, price: 900_000, original_price: 1_000_000, list_price: 1_000_000, sale_price: 900_000, online_discount_amount: 50_000, final_online_price: 850_000,
    price_display: null, is_promotion: true, price_provenance: 'hita-exact-v1' }
const unpriced = (label: string) => ({ ...base, price: null, original_price: null, list_price: null, sale_price: null, online_discount_amount: null, final_online_price: null,
    price_display: label, is_promotion: false, price_provenance: 'hita-exact-v1' })

describe('canonical Production DTO in the listing contract', () => {
    it('accepts a priced canonical row and both unpriced labels', () => {
        expect(isPublicSnapshotListingProduct(priced)).toBe(true)
        expect(isPublicSnapshotListingProduct(unpriced('Liên hệ báo giá'))).toBe(true)
        expect(isPublicSnapshotListingProduct(unpriced('Cần liên hệ xác nhận giá'))).toBe(true)
    })
    it('rejects an unknown label, wrong provenance, voucher folded into the price and a legacy row with the new label', () => {
        expect(isPublicSnapshotListingProduct(unpriced('Giá tốt'))).toBe(false)
        expect(isPublicSnapshotListingProduct({ ...priced, price_provenance: 'hita-exact-v2' })).toBe(false)
        expect(isPublicSnapshotListingProduct({ ...priced, price: 850_000 })).toBe(false)
        expect(isPublicSnapshotListingProduct({ ...unpriced('Cần liên hệ xác nhận giá'), price_provenance: null })).toBe(false)
    })
})
