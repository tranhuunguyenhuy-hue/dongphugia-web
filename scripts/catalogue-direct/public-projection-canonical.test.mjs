import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { projectProduct, buildProjection, productBucket } from './public-projection.mjs'
import { projectPublicContent } from './public-product-content.mjs'
import { CANONICAL_LABEL_CONTACT, CANONICAL_LABEL_UNVERIFIED } from './public-canonical-pricing.mjs'

const NOW = new Date('2026-11-25T00:00:00Z'), fresh = '2026-11-24T20:00:00.000Z'
const evidence = { checkpoint: 'a'.repeat(40), m3CodeSha: 'b'.repeat(40), m3RunId: '123' }
const canonical = { scope: { categories: ['thiet-bi-ve-sinh'], brands: ['toto'] }, now: NOW, maxAgeMs: 72 * 3600_000, csvSha256: 'c'.repeat(64), planSha: 'd'.repeat(64) }
const legacy = { price: 700000, original_price: 800000, list_price: 800000, sale_price: 700000, online_discount_amount: 20000,
  price_updated_at: new Date('2026-07-02T00:00:00Z'), price_source: 'hita', source_system: 'hita', price_state: 'priced', price_confidence: 'high' }
const base = (id, over = {}) => ({ id, name: `SP ${id}`, display_name: null, slug: `sp-${id}`, sku: `SKU${id}`, image_main_url: 'https://cdn.hita.com.vn/e.jpg', is_featured: false,
  brand_name: 'TOTO', brand_slug: 'toto', categories: { slug: 'thiet-bi-ve-sinh', name: 'Thiết bị vệ sinh' }, publicDescription: '<p>Mô tả</p>', publicDocuments: [], ...legacy, ...over })
const path = (cat = 'thiet-bi-ve-sinh') => ({ categorySlug: cat, subcategorySlug: 'bon-cau', categoryName: cat, subcategoryName: 'Bồn cầu', taxonomyException: null })
const vis = { pdp: true, listing: true, search: true, sitemap: true }
const rows = [
  base(1, { canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '1000000', promotional_price_vnd: '900000', online_voucher_amount_vnd: '50000', canonical_price_checked_at: fresh }),
  base(2, { canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '2000000', canonical_price_checked_at: fresh }),
  base(3, { canonical_price_status: 'CONTACT_VERIFIED' }),
  base(4, { canonical_price_status: 'UNRESOLVED' }),
  base(5, { canonical_price_status: null }),                                   // TOTO, never crawled, HAS a legacy price: must be hidden
  base(6, { brand_name: 'INAX', brand_slug: 'inax' }),                          // sanitary, out of scope: unchanged legacy
  base(7, { categories: { slug: 'gach-op-lat', name: 'Gạch' } }, ),            // other category: unchanged legacy
]
const build = (opts = { restoreCommerce: true, canonical }) => {
  const dtos = rows.map(r => {
    const cat = r.categories.slug
    const dto = projectProduct(r, vis, path(cat), opts)
    const inScope = opts.canonical && cat === 'thiet-bi-ve-sinh' && r.brand_slug === 'toto'
    return { ...dto, publicContent: projectPublicContent(r, { rich: true, noReferencePrice: Boolean(inScope) }) }
  })
  return { dtos, built: buildProjection(dtos, evidence, [], opts) }
}
const pdp = (built, dto) => built.assets.get('products/' + productBucket(dto.url) + '.json').products.find(p => p.id === dto.id)

describe('#470 snapshot projection with canonical sanitary pricing', () => {
  it('in-scope rows use only canonical columns; legacy is never a fallback', () => {
    const { dtos } = build()
    assert.equal(dtos[0].price, 900000); assert.equal(dtos[0].original_price, 1000000); assert.equal(dtos[0].list_price, 1000000)
    assert.equal(dtos[0].sale_price, 900000); assert.equal(dtos[0].online_discount_amount, 50000); assert.equal(dtos[0].final_online_price, 850000)
    assert.equal(dtos[1].price, 2000000); assert.equal(dtos[1].sale_price, null); assert.equal(dtos[1].is_promotion, false)
    assert.equal(dtos[2].price, null); assert.equal(dtos[2].price_display, CANONICAL_LABEL_CONTACT)
    assert.equal(dtos[3].price, null); assert.equal(dtos[3].price_display, CANONICAL_LABEL_UNVERIFIED)
    assert.equal(dtos[4].price, null); assert.equal(dtos[4].price_display, CANONICAL_LABEL_UNVERIFIED); assert.equal(dtos[4].list_price, null)
    for (const d of dtos.slice(0, 5)) assert.equal(d.price_provenance, 'hita-exact-v1')
  })
  it('out-of-scope sanitary brands and other categories keep exactly the existing legacy behaviour', () => {
    const { dtos } = build(); const off = build({ restoreCommerce: true })
    for (const i of [5, 6]) assert.deepEqual(dtos[i], off.dtos[i])
    assert.equal(dtos[5].price, 700000); assert.equal(dtos[5].price_provenance, 'legacy-hita-pm-approved-2026-11-03')
  })
  it('legacy historical reference price is removed for in-scope rows only', () => {
    const { built, dtos } = build(); const off = build({ restoreCommerce: true })
    for (const i of [0, 1, 2, 3, 4]) assert.equal(pdp(built, dtos[i]).publicContent.referencePrice, null)
    assert.equal(pdp(off.built, off.dtos[0]).publicContent.referencePrice !== undefined, true)
  })
  it('one source of truth for PDP, listing, search and variants; voucher identical everywhere', () => {
    const { built, dtos } = build()
    const listing = built.assets.get('listings/thiet-bi-ve-sinh/bon-cau/1.json').products.find(p => p.id === 1)
    const search = [0, 1, 2, 3].flatMap(i => built.assets.get(`search/${i}.json`).products).find(p => p.id === 1)
    for (const view of [pdp(built, dtos[0]), listing, search]) { assert.equal(view.price, 900000); assert.equal(view.list_price, 1000000); assert.equal(view.final_online_price, 850000); assert.equal(view.online_discount_amount, 50000) }
  })
  it('manifest binds the snapshot to the exact CSV + plan and counts each state', () => {
    const { built } = build()
    assert.deepEqual(built.manifest.canonicalPricing, { provenance: 'hita-exact-v1', scope: canonical.scope, maxAgeHours: 72, csvSha256: 'c'.repeat(64), planSha: 'd'.repeat(64), priced: 2, contactVerified: 1, unverified: 2 })
    assert.equal(build({ restoreCommerce: true }).built.manifest.canonicalPricing, undefined)
  })
  it('is deterministic: same input => byte-identical assets and manifest', () => {
    const a = build().built, b = build().built
    assert.deepEqual([...a.assets.keys()], [...b.assets.keys()])
    for (const [k, v] of a.assets) assert.equal(JSON.stringify(v), JSON.stringify(b.assets.get(k)))
  })
  it('a stale verified price stops the build instead of shipping', () => {
    assert.throws(() => projectProduct(rows[0], vis, path(), { restoreCommerce: true, canonical: { ...canonical, now: new Date('2026-12-30T00:00:00Z') } }), /PUBLIC_CANONICAL_PRICE_STALE/)
  })
  it('a canonical DTO is rejected when canonical mode is off (contract stays closed)', () => {
    const { dtos } = build()
    assert.throws(() => buildProjection(dtos, evidence, [], { restoreCommerce: true }), /UNSAFE_DTO/)
  })
})
