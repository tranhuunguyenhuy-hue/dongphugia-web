import { describe, expect, it } from 'vitest'
import { buildM2PublicSnapshot, type PublicCapture } from './m2-public-snapshot.mjs'
import { mapLiveProduct, type PublicProductRow } from '../../apps/public/src/runtime/live-public-catalogue'

function fixture(): PublicCapture {
  const roots = ['thiet-bi-ve-sinh', 'thiet-bi-bep', 'vat-lieu-nuoc', 'gach-op-lat']
  let id = 0
  const entries = roots.flatMap((root, index) => Array.from({ length: index === 0 ? 50 : 1 }, () => {
    id++
    const row: PublicProductRow = { id, sku: `SKU-${id}`, name: `Public ${id}`, slug: `product-${id}`,
      display_name: null, description: 'Public description', image_main_url: null, is_featured: true,
      variant_group: id === 49 || id === 50 ? 'legacy-public-series' : null, variant_type: 'size', variant_label: `${id}`,
      category_name: root, category_slug: root, listing_name: 'Listing', listing_slug: 'listing', brand_name: null, brand_slug: null }
    const card = mapLiveProduct(row)
    return { product: { ...card, publicContent: { ...card.publicContent!, descriptionHtml: '<p>Public detail</p>' } },
      card, listed: id !== 1, searchable: id !== 2, priority: id === 49 ? 2 : 0, order: id }
  }))
  return { sourceSha: 'a'.repeat(40), productionSourceSha: 'b'.repeat(40), capturedAt: '2026-11-15T16:00:00.000Z', entries,
    categories: roots.map((root, index) => ({ category_slug: root, category_name: root, listing_slug: 'listing', listing_name: 'Listing', total_count: index === 0 ? 49 : 1 })), posts: [], blogCategories: [] }
}

describe('M2 immutable Public capture', () => {
  it('keeps search-only PDPs, exact listing order/pagination, rich details and independent checksums', () => {
    const result = buildM2PublicSnapshot(fixture())
    expect(result.manifest).toMatchObject({ products: 53, listingProducts: 52, searchProducts: 52, captureSource: 'm1-public-read-model' })
    const page = JSON.parse(result.files.find(f => f.name === 'listings/thiet-bi-ve-sinh/listing/1.json')!.body)
    expect(page.products).toHaveLength(48)
    expect(page.products[0].id).toBe(49)
    expect(page.products.some((p: {id:number}) => p.id === 1)).toBe(false)
    expect(JSON.parse(result.files.find(f => f.name === 'listings/thiet-bi-ve-sinh/listing/2.json')!.body).products).toHaveLength(1)
    const allDetails = result.files.filter(f => f.name.startsWith('products/')).flatMap(f => JSON.parse(f.body).products)
    expect(allDetails.find(p => p.id === 1).publicContent.descriptionHtml).toBe('<p>Public detail</p>')
    expect(result.files.every(f => /^[a-f0-9]{64}$/.test(f.sha256) && f.bytes < 2_000_000)).toBe(true)
    const variants = JSON.parse(result.files.find(f => f.name.startsWith('variants/'))!.body)
    expect(variants.memberIds).toEqual([49, 50])
    expect(variants.products.map((p: {variant_group:string}) => p.variant_group)).toEqual(['public-1', 'public-1'])
  })

  it('locks identity to contents, source and capture timestamp', () => {
    const capture = fixture()
    const first = buildM2PublicSnapshot(capture)
    expect(buildM2PublicSnapshot(capture).checkpoint).toBe(first.checkpoint)
    capture.entries[0].product.name = 'Updated public name'
    expect(buildM2PublicSnapshot(capture).checkpoint).not.toBe(first.checkpoint)
    expect(capture.entries[48].product.variant_group).toBe('legacy-public-series')
  })

  it('rejects private fields, duplicate routes and mismatched SQL counts before output', () => {
    const privateCapture = fixture()
    Object.assign(privateCapture.entries[0].product, { credential: 'must-never-be-exported' })
    expect(() => buildM2PublicSnapshot(privateCapture)).toThrow('M2_CAPTURE_PUBLIC_PRODUCT_INVALID')
    const duplicate = fixture()
    duplicate.entries.push(duplicate.entries[0])
    expect(() => buildM2PublicSnapshot(duplicate)).toThrow('M2_CAPTURE_PUBLIC_PRODUCT_INVALID')
    const mismatch = fixture()
    mismatch.categories[0].total_count = 48
    expect(() => buildM2PublicSnapshot(mismatch)).toThrow('M2_CAPTURE_LISTING_COUNT_MISMATCH')
  })
})
