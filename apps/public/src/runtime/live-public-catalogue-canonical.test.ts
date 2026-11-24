import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ readPublicRows: vi.fn() }))
vi.mock('./public-db', () => ({ readPublicRows: mocks.readPublicRows }))

import { getLiveListing, getLiveListingPreview, getLiveProductByCategory, getLiveVariantSiblings, mapLiveProduct, searchLiveProducts, type PublicProductRow } from './live-public-catalogue'
import { supportedListingKeys } from './listing-query'

// #470 (Owner decision: live PostgreSQL via Hyperdrive). Flag PUBLIC_CANONICAL_PRICING is OFF by default.
const row = (over: Partial<PublicProductRow> & Record<string, unknown> = {}) => ({
    id: 1, sku: 'LT533R#XW', name: 'Chậu', display_name: null, slug: 'chau', description: 'mô tả', image_main_url: null, is_featured: false,
    variant_group: null, variant_type: null, variant_label: null, category_name: 'Thiết bị vệ sinh', category_slug: 'thiet-bi-ve-sinh',
    listing_name: 'Chậu', listing_slug: 'chau-lavabo', brand_name: 'TOTO', brand_slug: 'toto', total_count: '1', ...over,
}) as PublicProductRow
const production = () => { vi.stubEnv('APP_ENV', 'production'); vi.stubEnv('PUBLIC_CANONICAL_PRICING', 'on') }
beforeEach(() => { mocks.readPublicRows.mockReset(); vi.unstubAllEnvs() })
afterEach(() => vi.unstubAllEnvs())
const sqlOf = (call = 0) => String(mocks.readPublicRows.mock.calls[call][0])

describe('flag OFF (Production default)', () => {
    it('statements contain no canonical column and rows get no price, whatever the row carries', async () => {
        vi.stubEnv('APP_ENV', 'production')
        mocks.readPublicRows.mockResolvedValue([row({ canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '1000000' })])
        const { products } = await getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')
        expect(sqlOf()).not.toMatch(/regular_price_vnd|canonical_price_status|promotional_price_vnd|online_voucher/)
        expect(products[0]).toMatchObject({ price: null, price_display: 'Liên hệ báo giá' }); expect(products[0]).not.toHaveProperty('price_provenance')
    })
    it('flag set but APP_ENV is not production (e.g. preview): still OFF', async () => {
        vi.stubEnv('APP_ENV', 'preview'); vi.stubEnv('PUBLIC_CANONICAL_PRICING', 'on')
        mocks.readPublicRows.mockResolvedValue([row()]); await getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')
        expect(sqlOf()).not.toContain('canonical_price_status')
    })
    it('?sort= stays unsupported', () => { vi.stubEnv('APP_ENV', 'production'); expect(supportedListingKeys('thiet-bi-ve-sinh')).not.toContain('sort') })
})

describe('flag ON (Production)', () => {
    beforeEach(production)
    it('reads exactly the 4 granted canonical columns (never checked_at, never a legacy price column) in the same single statement', async () => {
        mocks.readPublicRows.mockResolvedValue([row()]); await getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')
        const sql = sqlOf()
        for (const col of ['p.regular_price_vnd', 'p.promotional_price_vnd', 'p.online_voucher_amount_vnd', 'p.canonical_price_status']) expect(sql).toContain(col)
        expect(sql).not.toMatch(/canonical_price_checked_at|p\.price\b|p\.list_price|p\.sale_price|p\.original_price|online_discount_amount|price_state/)
        expect(mocks.readPublicRows).toHaveBeenCalledTimes(1)
    })
    it.each([
        ['PRICE_VERIFIED regular only', { canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '1000000' }, { price: 1000000, list_price: 1000000, original_price: null, sale_price: null, online_discount_amount: null, final_online_price: null, is_promotion: false, price_display: null }],
        ['PRICE_VERIFIED promo + voucher (separate)', { canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '1000000', promotional_price_vnd: '900000', online_voucher_amount_vnd: '50000' }, { price: 900000, list_price: 1000000, original_price: 1000000, sale_price: 900000, online_discount_amount: 50000, final_online_price: 850000, is_promotion: true, price_display: null }],
        ['CONTACT_VERIFIED', { canonical_price_status: 'CONTACT_VERIFIED' }, { price: null, price_display: 'Liên hệ báo giá' }],
        ['UNRESOLVED', { canonical_price_status: 'UNRESOLVED' }, { price: null, price_display: 'Cần liên hệ xác nhận giá' }],
        ['NOT_FOUND', { canonical_price_status: 'NOT_FOUND' }, { price: null, price_display: 'Cần liên hệ xác nhận giá' }],
        ['DISCONTINUED', { canonical_price_status: 'DISCONTINUED' }, { price: null, price_display: 'Cần liên hệ xác nhận giá' }],
        ['NULL status (never crawled)', { canonical_price_status: null }, { price: null, price_display: 'Cần liên hệ xác nhận giá' }],
        ['missing column (old schema)', {}, { price: null, price_display: 'Cần liên hệ xác nhận giá' }],
        ['inconsistent verified data fails safe', { canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '100', promotional_price_vnd: '200' }, { price: null, price_display: 'Cần liên hệ xác nhận giá' }],
        ['verified but price missing fails safe', { canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: null }, { price: null, price_display: 'Cần liên hệ xác nhận giá' }],
    ])('in scope: %s', (_name, extra, expected) => {
        const p = mapLiveProduct(row({ ...extra, price: 111, list_price: 111, sale_price: 100 }))   // legacy values are ignored even if they leak into the row
        expect(p).toMatchObject({ ...expected, price_provenance: 'hita-exact-v1', stock_status: 'contact' })
        if (expected.price === null) expect(p).toMatchObject({ list_price: null, sale_price: null, original_price: null, online_discount_amount: null, final_online_price: null })
    })
    it('out-of-scope rows (other brand, other category) are untouched: no provenance, no price', () => {
        for (const other of [row({ brand_slug: 'inax', brand_name: 'INAX' }), row({ brand_slug: null, brand_name: null }), row({ category_slug: 'gach-op-lat' }), row({ category_slug: 'thiet-bi-bep' })]) {
            const p = mapLiveProduct({ ...other, canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '1000000' } as PublicProductRow)
            expect(p).toMatchObject({ price: null, price_display: 'Liên hệ báo giá' }); expect(p).not.toHaveProperty('price_provenance')
        }
    })
    it('brand scope is configurable and exact', () => {
        vi.stubEnv('PUBLIC_CANONICAL_PRICE_BRANDS', 'toto,inax')
        expect(mapLiveProduct(row({ brand_slug: 'inax', canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '5' })).price).toBe(5)
        expect(mapLiveProduct(row({ brand_slug: 'american-standard' })).price_provenance).toBeUndefined()
    })
    it('default order puts verified prices first; price sort uses only PRICE_VERIFIED values, rest last; no per-row extra queries', async () => {
        mocks.readPublicRows.mockResolvedValue([row()])
        await getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')
        expect(sqlOf(0)).toContain("p.canonical_price_status IS DISTINCT FROM 'PRICE_VERIFIED' THEN 1 ELSE 0 END,p.listing_priority")
        await getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo', 1, 48, { priceSort: 'asc' })
        expect(sqlOf(1)).toContain("CASE WHEN p.canonical_price_status='PRICE_VERIFIED' THEN COALESCE(p.promotional_price_vnd,p.regular_price_vnd) END ASC NULLS LAST,p.listing_priority")
        await getLiveListing('thiet-bi-bep', 'voi', 1, 48, { priceSort: 'desc' })
        expect(sqlOf(2)).not.toContain("canonical_price_status='PRICE_VERIFIED' THEN")   // a sort request on another category falls back to the default order
        expect(mocks.readPublicRows).toHaveBeenCalledTimes(3)
    })
    it('?sort= is supported for sanitary only', () => {
        expect(supportedListingKeys('thiet-bi-ve-sinh')).toContain('sort'); expect(supportedListingKeys('thiet-bi-bep')).not.toContain('sort')
    })
    it('PDP, preview, search and siblings share the same columns and DTO (one query each)', async () => {
        const detail = { ...row({ canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '1000000', promotional_price_vnd: '900000', online_voucher_amount_vnd: '50000' }), gallery_images: [], documents: [], specifications: {} }
        mocks.readPublicRows.mockResolvedValue([detail])
        const pdp = await getLiveProductByCategory('thiet-bi-ve-sinh', 'chau'); expect(pdp).toMatchObject({ price: 900000, final_online_price: 850000, price_provenance: 'hita-exact-v1' })
        await getLiveListingPreview('thiet-bi-ve-sinh', 'chau-lavabo'); await getLiveVariantSiblings('GROUP', 1)
        const search = await searchLiveProducts('LT533', 1, 24)
        expect(search.results[0]).toMatchObject({ price: 900000, final_online_price: 850000, price_provenance: 'hita-exact-v1', online_discount_amount: 50000 })
        for (let i = 0; i < 4; i++) expect(sqlOf(i)).toContain('p.canonical_price_status')
        expect(mocks.readPublicRows).toHaveBeenCalledTimes(4)
    })
})

describe('schema/permission fail-safe (flag ON)', () => {
    beforeEach(production)
    it('missing column (42703): retries the same statement without canonical columns, in-scope rows become "Cần liên hệ xác nhận giá", never legacy', async () => {
        vi.resetModules(); mocks.readPublicRows.mockReset()
        const err = Object.assign(new Error('column does not exist'), { code: '42703' })
        mocks.readPublicRows.mockRejectedValueOnce(err).mockResolvedValue([row({ price: 999 })])
        const mod = await import('./live-public-catalogue')
        const { products } = await mod.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')
        expect(sqlOf(0)).toContain('canonical_price_status'); expect(sqlOf(1)).not.toContain('canonical_price_status')
        expect(products[0]).toMatchObject({ price: null, price_display: 'Cần liên hệ xác nhận giá', price_provenance: 'hita-exact-v1' })
        // remembered: the next request does not pay a failing round trip again
        mocks.readPublicRows.mockClear(); mocks.readPublicRows.mockResolvedValue([row()])
        await mod.getLiveListingPreview('thiet-bi-ve-sinh', 'chau-lavabo')
        expect(mocks.readPublicRows).toHaveBeenCalledTimes(1); expect(sqlOf(0)).not.toContain('canonical_price_status')
    })
    it('other database errors are NOT swallowed', async () => {
        vi.resetModules(); mocks.readPublicRows.mockReset()
        mocks.readPublicRows.mockRejectedValue(Object.assign(new Error('boom'), { code: '57014' }))
        const mod = await import('./live-public-catalogue')
        await expect(mod.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')).rejects.toThrow('boom')
        expect(mocks.readPublicRows).toHaveBeenCalledTimes(1)
    })
    it('a retry that also fails propagates and does NOT disable canonical reads for later requests', async () => {
        vi.resetModules(); mocks.readPublicRows.mockReset()
        const denied = Object.assign(new Error('permission denied'), { code: '42501' })
        mocks.readPublicRows.mockRejectedValueOnce(denied).mockRejectedValueOnce(denied).mockResolvedValue([row()])
        const mod = await import('./live-public-catalogue')
        await expect(mod.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')).rejects.toThrow('permission denied')
        await mod.getLiveListingPreview('thiet-bi-ve-sinh', 'chau-lavabo')
        expect(sqlOf(2)).toContain('canonical_price_status')
    })
    it('siblings: 42501 (series spec columns not granted to the Production role) degrades to no siblings; other errors propagate', async () => {
        vi.resetModules(); mocks.readPublicRows.mockReset()
        mocks.readPublicRows.mockRejectedValue(Object.assign(new Error('permission denied'), { code: '42501' }))
        const mod = await import('./live-public-catalogue')
        expect(await mod.getLiveVariantSiblings('G', 1)).toEqual([])
        mocks.readPublicRows.mockReset(); mocks.readPublicRows.mockRejectedValue(Object.assign(new Error('boom'), { code: '57014' }))
        await expect(mod.getLiveVariantSiblings('G', 1)).rejects.toThrow('boom')
    })
})
