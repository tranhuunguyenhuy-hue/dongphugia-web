import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ readPublicRows: vi.fn() }))
vi.mock('./public-db', () => ({ readPublicRows: mocks.readPublicRows }))

import { getLiveCategories, getLiveCategory, getLiveListing, getLiveListingPreview, getLiveListingLeaves, getLiveListingRouteMetadata, getLiveProduct, getLiveBrandsForListing, getLiveProductByCategory, getLiveSeriesFacet, getLiveVariantSiblings, mapLiveProduct, searchLiveProducts } from './live-public-catalogue'

const product = {
  id: 42,
  sku: 'DPG-42',
  name: 'Vòi rửa chén',
  display_name: null,
  slug: 'voi-rua-chen-42',
  description: 'Mô tả sản phẩm',
  image_main_url: 'https://dpg-products.b-cdn.net/voi-rua-chen.jpg',
  is_featured: false,
  variant_group: null,
  variant_type: null,
  variant_label: null,
  category_name: 'Thiết bị bếp',
  category_slug: 'thiet-bi-bep',
  listing_name: 'Vòi rửa chén',
  listing_slug: 'voi-rua-chen',
  brand_name: null,
  brand_slug: null,
}

describe('Live public catalogue projection', () => {
  beforeEach(() => mocks.readPublicRows.mockReset())
  it('uses only public, active, PDP-visible products and listing-visible rows for PLPs', async () => {
    mocks.readPublicRows.mockResolvedValueOnce([{ ...product, total_count: '1' }])
    const listing = await getLiveListing('thiet-bi-bep', 'voi-rua-chen', 1)
    const [statement, values] = mocks.readPublicRows.mock.calls[0]
    expect(statement).toContain("p.publication_status='public'")
    expect(statement).toContain("p.pdp_visibility='public'")
    expect(statement).toContain("p.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'")
    expect(statement).toContain('char_length(p.name)<=240')
    expect(statement).toContain('char_length(p.sku)<=120')
    expect(statement).toContain("c.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'")
    expect(statement).toContain("s.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'")
    expect(statement).toContain("p.listing_visibility IN ('default','low_priority')")
    expect(values).toEqual(['thiet-bi-bep', 'voi-rua-chen', 0, 48, [], false, []])
    expect(listing.totalCount).toBe(1)
    expect(listing.products[0]).toMatchObject({
      id: 42,
      price: null,
      price_display: 'Liên hệ báo giá',
      stock_status: 'contact',
    })
  })

  it('uses bound brand and featured filters in the one-page PostgreSQL query', async () => {
    mocks.readPublicRows.mockResolvedValueOnce([{ ...product, total_count: '2' }])
    await getLiveListing('thiet-bi-bep', 'voi-rua-chen', 2, 12, { brandSlugs: ['acme', 'other-brand'], featured: true })
    const [statement, values] = mocks.readPublicRows.mock.calls[0]
    expect(statement).toContain('cardinality($5::text[])=0 OR b.slug=ANY($5::text[])')
    expect(statement).toContain('NOT $6::boolean OR p.is_featured=true')
    expect(statement).toContain('LIMIT $4 OFFSET $3')
    expect(values).toEqual(['thiet-bi-bep', 'voi-rua-chen', 12, 12, ['acme', 'other-brand'], true, []])
  })

  it('loads the same ordered category-root preview rows without an unneeded window count', async () => {
    mocks.readPublicRows.mockResolvedValueOnce([{ ...product }])
    const preview = await getLiveListingPreview('thiet-bi-bep', 'voi-rua-chen')
    const [statement, values, label] = mocks.readPublicRows.mock.calls[0]
    expect(preview).toHaveLength(1)
    expect(statement).not.toContain('count(*) OVER()')
    expect(statement).toContain('LIMIT $3')
    expect(statement).toContain("p.listing_visibility IN ('default','low_priority')")
    expect(values).toEqual(['thiet-bi-bep', 'voi-rua-chen', 48])
    expect(label).toBe('category-root-featured')
  })

  it('rejects unsafe or excessive listing filters before querying PostgreSQL', async () => {
    await expect(getLiveListing('thiet-bi-bep', 'voi-rua-chen', 1, 12, { brandSlugs: ['bad/slug'] }))
      .resolves.toMatchObject({ products: [], totalCount: 0 })
    await expect(getLiveListing('thiet-bi-bep', 'voi-rua-chen', 1, 12, { brandSlugs: Array(33).fill('brand') }))
      .resolves.toMatchObject({ products: [], totalCount: 0 })
    expect(mocks.readPublicRows).not.toHaveBeenCalled()
  })

  it('resolves PLP route metadata with one parameterized listing-scoped existence query', async () => {
    mocks.readPublicRows.mockResolvedValueOnce([{ categoryName: 'Thiết bị vệ sinh', listingName: 'Bồn cầu' }])
    await expect(getLiveListingRouteMetadata('thiet-bi-ve-sinh', 'bon-cau')).resolves.toEqual({
      categoryName: 'Thiết bị vệ sinh', listingName: 'Bồn cầu',
    })
    expect(mocks.readPublicRows).toHaveBeenCalledOnce()
    const [statement, values] = mocks.readPublicRows.mock.calls[0]
    expect(statement).toContain('FROM dpg_app.categories c')
    expect(statement).toContain('JOIN dpg_app.subcategories s')
    expect(statement).toContain('EXISTS (SELECT 1 FROM dpg_app.products p')
    expect(statement).toContain("p.publication_status='public'")
    expect(statement).toContain("p.pdp_visibility='public'")
    expect(statement).toContain("p.listing_visibility IN ('default','low_priority')")
    expect(statement).toContain('c.slug=$1 AND s.slug=$2')
    expect(statement).toContain('LIMIT 1')
    expect(statement).not.toContain('GROUP BY')
    expect(statement).not.toContain('SELECT DISTINCT')
    expect(values).toEqual(['thiet-bi-ve-sinh', 'bon-cau'])
  })

  it('loads one category of visible listing leaves without brands or first product pages', async () => {
    mocks.readPublicRows.mockResolvedValueOnce([{ slug: 'bon-cau', name: 'Bồn cầu', total_count: '145' }])
    await expect(getLiveListingLeaves('thiet-bi-ve-sinh')).resolves.toEqual([
      { slug: 'bon-cau', name: 'Bồn cầu', totalCount: 145 },
    ])
    expect(mocks.readPublicRows).toHaveBeenCalledOnce()
    const [statement, values] = mocks.readPublicRows.mock.calls[0]
    expect(statement).toContain('FROM dpg_app.categories c JOIN dpg_app.subcategories s')
    expect(statement).toContain('JOIN dpg_app.products p ON p.category_id=c.id AND p.subcategory_id=s.id')
    expect(statement).toContain("p.listing_visibility IN ('default','low_priority')")
    expect(statement).toContain('GROUP BY s.id,s.slug,s.name')
    expect(statement).not.toContain('LEFT JOIN dpg_app.brands')
    expect(statement).not.toContain('ORDER BY p.listing_priority')
    expect(values).toEqual(['thiet-bi-ve-sinh'])
  })

  it('loads a single category root without fan-out to the other three categories', async () => {
    mocks.readPublicRows
      .mockResolvedValueOnce([{
        category_slug: 'thiet-bi-bep', category_name: 'Thiết bị bếp',
        listing_slug: 'voi-rua-chen', listing_name: 'Vòi rửa chén', total_count: '12',
      }])
      .mockResolvedValueOnce([{ category_slug: 'thiet-bi-bep', slug: 'acme', name: 'Acme' }])
      .mockResolvedValueOnce([{ ...product, total_count: '12' }])

    const category = await getLiveCategory('thiet-bi-bep')

    expect(category).toMatchObject({
      slug: 'thiet-bi-bep', name: 'Thiết bị bếp', totalCount: 12,
      listings: [{ slug: 'voi-rua-chen', totalCount: 12 }],
      homeProducts: [{ id: 42 }], brands: [{ slug: 'acme', name: 'Acme' }],
    })
    expect(mocks.readPublicRows).toHaveBeenCalledTimes(3)
    expect(mocks.readPublicRows.mock.calls[0][1]).toEqual(['thiet-bi-bep'])
    expect(mocks.readPublicRows.mock.calls[1][1]).toEqual(['thiet-bi-bep'])
    expect(mocks.readPublicRows.mock.calls[2][1]).toEqual(['thiet-bi-bep', 'voi-rua-chen', 48])
    expect(mocks.readPublicRows.mock.calls[2][2]).toBe('category-root-featured')
    expect(mocks.readPublicRows.mock.calls[0][0]).toContain('AND c.slug=$1 GROUP BY')
    expect(mocks.readPublicRows.mock.calls[1][0]).toContain('AND c.slug=$1 AND b.slug IS NOT NULL')
  })

  it('does not scan all Public products for global homepage brand facets', async () => {
    mocks.readPublicRows
      .mockResolvedValueOnce([{
        category_slug: 'thiet-bi-bep', category_name: 'Thiết bị bếp',
        listing_slug: 'voi-rua-chen', listing_name: 'Vòi rửa chén', total_count: '12',
      }])
      .mockResolvedValueOnce([{ ...product }])
    const categories = await getLiveCategories()
    expect(categories).toHaveLength(1)
    expect(mocks.readPublicRows).toHaveBeenCalledTimes(2)
    expect(mocks.readPublicRows.mock.calls.map(call => call[2])).toEqual([
      'category-listing-counts', 'category-root-featured',
    ])
  })

  it('returns no route metadata for unsupported categories or missing eligible listings', async () => {
    await expect(getLiveListingRouteMetadata('admin-users', 'private')).resolves.toBeNull()
    expect(mocks.readPublicRows).not.toHaveBeenCalled()
    mocks.readPublicRows.mockResolvedValueOnce([])
    await expect(getLiveListingRouteMetadata('thiet-bi-ve-sinh', 'unpublished-listing')).resolves.toBeNull()
    expect(mocks.readPublicRows).toHaveBeenCalledOnce()
  })

  it('keeps unapproved prices and remote image hosts out of Public projections', () => {
    const projected = mapLiveProduct({
      ...product,
      price: 1000,
      image_main_url: 'https://untrusted.example/image.jpg',
    } as typeof product)
    expect(projected.price).toBeNull()
    expect(projected.price_display).toBe('Liên hệ báo giá')
    expect(projected.stock_status).toBe('contact')
    expect(projected.image_main_url).toBeNull()
  })

  it('rewrites the legacy Bunny product hostname to its documented Pull Zone alias', () => {
    const projected = mapLiveProduct({
      ...product,
      image_main_url: 'https://cdn.dongphugia.com.vn/migrated/viglacera/item.webp',
    })
    expect(projected.image_main_url).toBe('https://dpg-products.b-cdn.net/migrated/viglacera/item.webp')
    expect(projected.publicContent?.gallery).toEqual([
      'https://dpg-products.b-cdn.net/migrated/viglacera/item.webp',
    ])
  })

  it('loads bounded PDP media and sanitized content with one parameterized read', async () => {
    mocks.readPublicRows.mockResolvedValueOnce([{
      ...product,
      image_main_url: 'https://cdn.dongphugia.com.vn/migrated/viglacera/item.webp',
      gallery_images: [{ image_url: 'https://cdn.dongphugia.com.vn/migrated/viglacera/gallery.webp' }],
      description_html: '<p>Chi tiết <img src="https://cdn.dongphugia.com.vn/migrated/viglacera/detail.webp"></p><script>bad()</script>',
      specifications: { 'Kích thước': '600 mm' },
      documents: [{ name: 'Hướng dẫn', url: 'https://cdn.dongphugia.com.vn/migrated/viglacera/manual.pdf', type: 'manual', size: 400 }],
      product_feature_values: [{ product_features: { name: 'Tiết kiệm nước' } }],
    }])
    const result = await getLiveProduct('thiet-bi-bep', 'voi-rua-chen', 'voi-rua-chen-42')
    const [statement, values] = mocks.readPublicRows.mock.calls[0]
    expect(statement).toContain('dpg_app.product_descriptions')
    expect(statement).toContain('dpg_app.product_documents')
    expect(statement).toContain('dpg_app.product_spec_values')
    expect(statement).toContain('LIMIT 12')
    expect(values).toEqual(['thiet-bi-bep', 'voi-rua-chen', 'voi-rua-chen-42'])
    expect(result?.publicContent).toMatchObject({
      descriptionHtml: '<p>Chi tiết <img src="https://dpg-products.b-cdn.net/migrated/viglacera/detail.webp" loading="lazy" /></p>',
      specifications: { 'Kích thước': '600 mm' },
      gallery: [
        'https://dpg-products.b-cdn.net/migrated/viglacera/item.webp',
        'https://dpg-products.b-cdn.net/migrated/viglacera/gallery.webp',
      ],
      documents: [{ name: 'Hướng dẫn', url: 'https://dpg-products.b-cdn.net/migrated/viglacera/manual.pdf', type: 'manual', size: '400' }],
    })
    expect(result?.product_feature_values).toEqual([{ product_features: { name: 'Tiết kiệm nước' } }])
  })

  it('looks up PDP slugs within one public category without scanning its listings', async () => {
    mocks.readPublicRows.mockResolvedValueOnce([{ ...product }])
    await getLiveProductByCategory('thiet-bi-bep', 'voi-rua-chen-42')
    const [statement, values] = mocks.readPublicRows.mock.calls[0]
    expect(statement).toContain("c.slug=$1 AND p.slug=$2")
    expect(statement).not.toContain('s.slug=$2')
    expect(values).toEqual(['thiet-bi-bep', 'voi-rua-chen-42'])
  })

  it('reads available brands with a bounded SQL query instead of paging every product', async () => {
    mocks.readPublicRows.mockResolvedValueOnce([{ slug: 'acme', name: 'Acme' }])
    await expect(getLiveBrandsForListing('thiet-bi-bep', 'voi-rua-chen'))
      .resolves.toEqual([{ slug: 'acme', name: 'Acme' }])
    const [statement, values] = mocks.readPublicRows.mock.calls[0]
    expect(statement).toContain('SELECT DISTINCT b.slug,b.name')
    expect(statement).toContain('b.is_active=true')
    expect(statement).toContain('LIMIT 32')
    expect(values).toEqual(['thiet-bi-bep', 'voi-rua-chen'])
  })

  it('allows search-only visibility in SKU search while binding the search value', async () => {
    mocks.readPublicRows.mockResolvedValueOnce([{ ...product, total_count: '1' }])
    const result = await searchLiveProducts('DPG-42', 1, 24)
    const [statement, values] = mocks.readPublicRows.mock.calls[0]
    expect(statement).toContain("p.search_visibility='visible'")
    expect(statement).not.toContain('listing_visibility')
    expect(values).toEqual(['%DPG-42%', 'DPG-42', 24, 0])
    expect(result.results[0]).toMatchObject({ sku: 'DPG-42', price: null, price_display: 'Liên hệ báo giá' })
  })
})

describe('#432 series facet and variant siblings', () => {
  beforeEach(() => mocks.readPublicRows.mockReset())

  it('filters SKUs by approved series options bound to the selected brand and keeps one row per SKU', async () => {
    mocks.readPublicRows.mockResolvedValueOnce([{ ...product, total_count: '1' }])
    await getLiveListing('thiet-bi-ve-sinh', 'voi-chau', 1, 24, { brandSlugs: ['toto'], seriesSlugs: ['toto-gf-series', 'toto-ge-series'] })
    const [statement, values] = mocks.readPublicRows.mock.calls[0]
    expect(statement).toContain('cardinality($7::text[])=0 OR EXISTS')
    expect(statement).toContain("sd.key='Bộ sưu tập'")
    expect(statement).toContain('sv.option_id')
    expect(statement).toContain("left(so.slug,length(b.slug)+1)=b.slug||'-'")
    expect(statement).not.toMatch(/GROUP BY/)
    expect(values[6]).toEqual(['toto-gf-series', 'toto-ge-series'])
  })

  it('ignores series tags without a brand or of another brand (never an empty/odd listing)', async () => {
    mocks.readPublicRows.mockResolvedValue([{ ...product, total_count: '1' }])
    await getLiveListing('thiet-bi-ve-sinh', 'voi-chau', 1, 24, { seriesSlugs: ['toto-gf-series'] })
    expect(mocks.readPublicRows.mock.calls[0][1][6]).toEqual([])
    await getLiveListing('thiet-bi-ve-sinh', 'voi-chau', 1, 24, { brandSlugs: ['inax'], seriesSlugs: ['toto-gf-series', 'inax-s600-line'] })
    expect(mocks.readPublicRows.mock.calls[1][1][6]).toEqual(['inax-s600-line'])
  })

  it('facet needs a brand, counts real public SKUs, and reports stale selections as dropped', async () => {
    expect(await getLiveSeriesFacet('thiet-bi-ve-sinh', 'voi-chau', [], ['toto-gf-series'])).toEqual({ applicable: false, options: [], selected: [], dropped: ['toto-gf-series'] })
    expect(mocks.readPublicRows).not.toHaveBeenCalled()
    mocks.readPublicRows.mockResolvedValueOnce([
      { slug: 'toto-ge-series', name: 'GE Series', brand_slug: 'toto', sku_count: '2' },
      { slug: 'toto-gf-series', name: 'GF Series', brand_slug: 'toto', sku_count: '10' },
      { slug: 'bad slug', name: 'x', brand_slug: 'toto', sku_count: '3' },
      { slug: 'toto-zz-series', name: 'ZZ', brand_slug: 'toto', sku_count: '0' },
    ])
    const facet = await getLiveSeriesFacet('thiet-bi-ve-sinh', 'voi-chau', ['toto'], ['toto-gf-series', 'toto-gone-series'])
    const [statement] = mocks.readPublicRows.mock.calls[0]
    expect(statement).toContain("p.listing_visibility IN ('default','low_priority')")
    expect(statement).toContain("p.pdp_visibility='public'")
    expect(statement).toContain('count(DISTINCT p.id)')
    expect(facet.applicable).toBe(true)
    expect(facet.options).toEqual([
      { slug: 'toto-ge-series', name: 'GE Series', brandSlug: 'toto', count: 2, selected: false },
      { slug: 'toto-gf-series', name: 'GF Series', brandSlug: 'toto', count: 10, selected: true },
    ])
    expect(facet.selected).toEqual(['toto-gf-series'])
    expect(facet.dropped).toEqual(['toto-gone-series'])
  })

  it('facet is hidden when no approved series has a public SKU in the context', async () => {
    mocks.readPublicRows.mockResolvedValueOnce([])
    expect(await getLiveSeriesFacet('thiet-bi-ve-sinh', 'bon-cau', ['toto'])).toEqual({ applicable: false, options: [], selected: [], dropped: [] })
  })

  it('siblings: same group + same brand + same sub-category, public only, no 8-item truncation, mixed/quarantined groups excluded', async () => {
    mocks.readPublicRows.mockResolvedValueOnce([{ ...product, id: 7, variant_group: 'TLG11201B', variant_label: 'Chrome' }])
    const siblings = await getLiveVariantSiblings('TLG11201B', 5)
    const [statement, values] = mocks.readPublicRows.mock.calls[0]
    expect(statement).toContain("p.publication_status='public'")
    expect(statement).toContain('p.brand_id=(SELECT cur.brand_id')
    expect(statement).toContain('p.subcategory_id=(SELECT cur.subcategory_id')
    expect(statement).toContain('count(DISTINCT sv.option_id)')
    expect(statement).toContain('<=1')
    expect(statement).toMatch(/LIMIT 60$/)
    expect(statement).not.toContain('LIMIT 8')
    expect(values).toEqual(['TLG11201B', 5])
    expect(siblings).toHaveLength(1)
    mocks.readPublicRows.mockClear()
    for (const group of ['TBW0', 'TBW01001B', 'TBG02302', 'TBG08302']) expect(await getLiveVariantSiblings(group, 5)).toEqual([])
    expect(mocks.readPublicRows).not.toHaveBeenCalled()
  })
})
