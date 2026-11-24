// @vitest-environment node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// #470 (Owner decision: live PostgreSQL via Hyperdrive). Real PostgreSQL, real Production column ACLs/RLS of dpg_public_catalogue,
// migrations 001/002 applied from supabase/prod-prep/470. Skipped unless POSTGRES_SNAPSHOT_INTEGRATION_URL is set (CI sets it).
const url = process.env.POSTGRES_SNAPSHOT_INTEGRATION_URL
const run = url ? describe : describe.skip
const root = path.resolve(__dirname, '../../..')
const prod = (file: string) => path.join(root, 'supabase/prod-prep/470', file)
const sqlOf = async (file: string) => roleNames((await readFile(file, 'utf8')).replaceAll(":'approved_sha'", "'integration-test-sha'"))

let admin: Client, db: Client, dbName = ''
const tag = Math.random().toString(36).slice(2, 8)
const PUB = `dpg_public_catalogue_${tag}`, ADM = `dpg_admin_api_${tag}`, RUN = `dpg_runtime_${tag}`, OPR = `dpg_operator470_${tag}`
const roleNames = (text: string) => text.replaceAll('dpg_public_catalogue', PUB).replaceAll('dpg_admin_api', ADM).replaceAll('dpg_runtime', RUN).replaceAll('dpg_operator470', OPR)
const log: string[] = []
vi.mock('../../../apps/public/src/runtime/public-db', () => ({
    publicPostgresEnabled: () => true,
    readPublicRows: async (sql: string, values: readonly unknown[]) => {
        log.push(sql)
        await db.query('begin read only'); await db.query(`set local role ${PUB}`)
        try { return (await db.query(sql, values as unknown[])).rows } finally { await db.query('rollback') }
    },
}))
const load = async () => { vi.resetModules(); return import('../../../apps/public/src/runtime/live-public-catalogue') }
const production = () => { vi.stubEnv('APP_ENV', 'production'); vi.stubEnv('PUBLIC_CANONICAL_PRICING', 'on') }
const sql = (text: string) => db.query(text)
type Mod = Awaited<ReturnType<typeof load>>
const CANON = /regular_price_vnd|promotional_price_vnd|online_voucher_amount_vnd|canonical_price_status/
/** Every public read path in one go; returns listing orders. Throws on any 5xx-worthy error. */
async function sweep(m: Mod) {
    const order = async (priceSort?: 'asc' | 'desc') => (await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo', 1, 48, priceSort ? { priceSort } : {})).products
    const def = await order(), asc = await order('asc'), desc = await order('desc')
    await m.getLiveProductByCategory('thiet-bi-ve-sinh', 't-promo'); await m.searchLiveProducts('T-', 1, 24)
    await m.getLiveListingPreview('thiet-bi-ve-sinh', 'chau-lavabo'); await m.getLiveVariantSiblings('G1', 1)
    await m.getLiveListing('gach-op-lat', 'gach-san')
    const all = [...def, ...asc, ...desc]
    expect(JSON.stringify(all)).not.toMatch(/:(111|222|333|444|555|50)[,}]/)    // no legacy value, no out-of-scope canonical value
    return { def: def.map(p => p.sku), asc: asc.map(p => p.sku), desc: desc.map(p => p.sku), all }
}

run('live PostgreSQL read path with real public-role ACL (#470)', () => {
    beforeAll(async () => {
        admin = new Client({ connectionString: url }); await admin.connect()
        dbName = 'live_canon_' + Math.random().toString(36).slice(2, 10)
        await admin.query(`create database ${dbName}`)
        const u = new URL(url!); u.pathname = '/' + dbName
        db = new Client({ connectionString: u.toString() }); await db.connect()
        await db.query(roleNames(await readFile(path.join(__dirname, 'live-public-schema.sql'), 'utf8')))
        await db.query(`
          insert into dpg_app.categories(slug,name) values ('thiet-bi-ve-sinh','Thiết bị vệ sinh'),('gach-op-lat','Gạch'),('thiet-bi-bep','Bếp');
          insert into dpg_app.subcategories(category_id,slug,name) values (1,'chau-lavabo','Chậu'),(2,'gach-san','Gạch sàn'),(3,'voi-bep','Vòi bếp');
          insert into dpg_app.brands(slug,name) values ('toto','TOTO'),('inax','INAX');
          insert into dpg_app.products(sku,name,slug,category_id,subcategory_id,brand_id,price,list_price,sale_price,original_price,online_discount_amount,price_state,variant_group) values
           ('T-VERIFIED','TOTO verified','t-verified',1,1,1,111,111,100,111,5,'priced','G1'),
           ('T-PROMO','TOTO promo+voucher','t-promo',1,1,1,222,222,200,222,9,'priced','G1'),
           ('T-CONTACT','TOTO contact','t-contact',1,1,1,333,333,null,333,null,'priced',null),
           ('T-NOSTATUS','TOTO never crawled (legacy price present)','t-nostatus',1,1,1,444,444,null,444,null,'priced',null),
           ('T-UNRESOLVED','TOTO unresolved','t-unresolved',1,1,1,null,null,null,null,null,'unknown',null),
           ('I-INAX','INAX out of scope (legacy price present)','i-inax',1,1,2,555,555,null,555,null,'priced',null),
           ('G-1','Gach legacy','g-1',2,2,null,666,666,null,666,null,'priced',null),
           ('B-1','Bep legacy','b-1',3,3,null,777,777,null,777,null,'priced',null);`)
    })
    afterAll(async () => {
        await db?.end(); if (dbName) await admin.query(`drop database if exists ${dbName} with (force)`)
        for (const role of [PUB, ADM, RUN, OPR]) await admin.query(`drop role if exists ${role}`).catch(() => undefined)
        await admin?.end()
    })
    beforeEach(() => { vi.unstubAllEnvs(); log.length = 0 })

    it('PHASE 0 (old schema, flag OFF): every public query works under the real role ACL', async () => {
        vi.stubEnv('APP_ENV', 'production')
        const m = await load()
        const listing = await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')
        expect(listing.totalCount).toBe(6)
        expect(listing.products.every(p => p.price === null && p.price_display === 'Liên hệ báo giá' && !('price_provenance' in p))).toBe(true)
        expect((await m.getLiveProductByCategory('thiet-bi-ve-sinh', 't-verified'))?.price).toBeNull()
        expect((await m.searchLiveProducts('T-', 1, 24)).total).toBeGreaterThan(0)
        expect((await m.getLiveListingPreview('gach-op-lat', 'gach-san')).length).toBe(1)
        // Finding: the Production public role cannot read spec_definitions.key / spec_options.slug (#432 grants not applied) -> siblings degrade to none, no 5xx.
        expect(await m.getLiveVariantSiblings('G1', 1)).toEqual([])
        expect(await m.getLiveSeriesFacet('thiet-bi-ve-sinh', 'chau-lavabo', ['toto'], ['toto-x'])).toMatchObject({ applicable: false, dropped: ['toto-x'] })
    })

    it('PHASE 1 (old schema, flag ON): fail-safe, no 5xx, in-scope SKUs show "Cần liên hệ xác nhận giá", never the legacy price', async () => {
        production()
        const m = await load()
        const listing = await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')
        const by = Object.fromEntries(listing.products.map(p => [p.sku, p]))
        expect(by['T-NOSTATUS']).toMatchObject({ price: null, price_display: 'Cần liên hệ xác nhận giá', price_provenance: 'hita-exact-v1' })
        expect(by['I-INAX']).toMatchObject({ price: null, price_display: 'Liên hệ báo giá' }); expect(by['I-INAX']).not.toHaveProperty('price_provenance')
        expect(log.some(s => s.includes('canonical_price_status'))).toBe(true)      // tried canonical first ...
        expect(log.some(s => !s.includes('canonical_price_status'))).toBe(true)      // ... then the same statement without it
    })

    it('PHASE 1b (old schema, flag ON): default/asc/desc keep the default order; the fallback statement references NO canonical column', async () => {
        production(); const m = await load()
        const r = await sweep(m)
        expect(r.asc).toEqual(r.def); expect(r.desc).toEqual(r.def)
        const fallbacks = log.filter(s => !CANON.test(s)); expect(fallbacks.length).toBeGreaterThan(0)
        for (const s of fallbacks) expect(s).not.toMatch(CANON)
    })

    it('PHASE 1c (001 applied, 002 NOT yet): 42501 -> fail-safe; 60 s memory; canonical retried after the window', async () => {
        await sql(await sqlOf(prod('001_canonical_price_columns.sql')))
        await sql("update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=50, canonical_price_checked_at=now() where sku='I-INAX'")
        production(); const m = await load()
        const t0 = Date.now(); const now = vi.spyOn(Date, 'now').mockReturnValue(t0)
        try {
            const r = await sweep(m); expect(r.asc).toEqual(r.def)
            expect(r.all.filter(p => p.sku.startsWith('T-')).every(p => p.price === null && p.price_display === 'Cần liên hệ xác nhận giá')).toBe(true)
            log.length = 0; await m.getLiveListingPreview('thiet-bi-ve-sinh', 'chau-lavabo')
            expect(log).toHaveLength(1); expect(log[0]).not.toMatch(CANON)                     // remembered: no failing round trip
            now.mockReturnValue(t0 + 61_000); log.length = 0
            await m.getLiveListingPreview('thiet-bi-ve-sinh', 'chau-lavabo')
            expect(log).toHaveLength(2); expect(log[0]).toMatch(CANON); expect(log[1]).not.toMatch(CANON)   // window over: tried again
        } finally { now.mockRestore() }
    })

    it('PHASE 2: migrations 001 + 002 apply (idempotent) and the minimum grants hold', async () => {
        for (const file of ['001_canonical_price_columns.sql', '002_canonical_price_grants.sql']) { await sql(await sqlOf(prod(file))); await sql(await sqlOf(prod(file))) }
        const can = async (role: string, stmt: string) => { await db.query('begin'); await db.query(`set local role ${role}`); try { await db.query(stmt); return true } catch { return false } finally { await db.query('rollback') } }
        expect(await can(PUB, 'select regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd, canonical_price_status from dpg_app.products limit 1')).toBe(true)
        expect(await can(PUB, 'select canonical_price_checked_at from dpg_app.products limit 1')).toBe(false)
        expect(await can(PUB, 'select price from dpg_app.products limit 1')).toBe(false)
        expect(await can(PUB, 'select list_price, sale_price, price_state from dpg_app.products limit 1')).toBe(false)
        expect(await can(PUB, "update dpg_app.products set regular_price_vnd = 1 where false")).toBe(false)
        expect(await can(RUN, 'select regular_price_vnd from dpg_app.products limit 1')).toBe(false)   // fixture has no table-level grant for runtime: proves nothing leaked beyond 002
    })

    it('PHASE 3 (flag ON, 001/002 applied): all states, exact SKU, scope, legacy never used', async () => {
        await sql(`update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=1000000, canonical_price_checked_at=now() where sku='T-VERIFIED';
                   update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=2000000, promotional_price_vnd=1800000, online_voucher_amount_vnd=100000, canonical_price_checked_at=now() where sku='T-PROMO';
                   update dpg_app.products set canonical_price_status='CONTACT_VERIFIED', canonical_price_checked_at=now() where sku='T-CONTACT';
                   update dpg_app.products set canonical_price_status='UNRESOLVED', canonical_price_checked_at=now() where sku='T-UNRESOLVED';`)
        production(); const m = await load()
        const by = Object.fromEntries((await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')).products.map(p => [p.sku, p]))
        expect(by['T-VERIFIED']).toMatchObject({ price: 1000000, list_price: 1000000, sale_price: null, original_price: null, final_online_price: null })
        expect(by['T-PROMO']).toMatchObject({ price: 1800000, list_price: 2000000, original_price: 2000000, sale_price: 1800000, online_discount_amount: 100000, final_online_price: 1700000, is_promotion: true })
        expect(by['T-CONTACT']).toMatchObject({ price: null, price_display: 'Liên hệ báo giá' })
        expect(by['T-UNRESOLVED']).toMatchObject({ price: null, price_display: 'Cần liên hệ xác nhận giá' })
        expect(by['T-NOSTATUS']).toMatchObject({ price: null, price_display: 'Cần liên hệ xác nhận giá' })      // legacy 444 must not appear
        expect(by['I-INAX']).toMatchObject({ price: null, price_display: 'Liên hệ báo giá' })                    // out of scope, untouched
        expect(JSON.stringify(by)).not.toMatch(/"(111|222|333|444|555)"|:(111|222|333|444|555)[,}]/)
        expect((await m.getLiveListing('gach-op-lat', 'gach-san')).products[0]).toMatchObject({ price: null }); expect(log.at(-1)).toContain('p.canonical_price_status')
        const pdp = await m.getLiveProductByCategory('thiet-bi-ve-sinh', 't-promo')
        expect(pdp).toMatchObject({ price: 1800000, final_online_price: 1700000, price_provenance: 'hita-exact-v1' })
        const search = await m.searchLiveProducts('T-PROMO', 1, 24); expect(search.results[0]).toMatchObject({ price: 1800000, final_online_price: 1700000, price_provenance: 'hita-exact-v1' })
        expect((await m.getLiveListingPreview('thiet-bi-ve-sinh', 'chau-lavabo')).find(p => p.sku === 'T-PROMO')?.price).toBe(1800000)
        expect(await m.getLiveVariantSiblings('G1', 1)).toEqual([])   // same #432 ACL finding; sibling prices are covered by the mocked unit test
    })

    it('PHASE 3b: ordering — default unchanged; explicit sort only on VISIBLE (TOTO, PRICE_VERIFIED) prices; INAX with populated canonical columns not sorted, not shown', async () => {
        production(); const m = await load()
        const r = await sweep(m)
        vi.unstubAllEnvs(); vi.stubEnv('APP_ENV', 'production'); const off = await load()
        const offDef = (await off.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')).products.map(p => p.sku)
        expect(r.def).toEqual(offDef)                                                    // default order identical to flag OFF
        expect(r.asc.slice(0, 2)).toEqual(['T-VERIFIED', 'T-PROMO']); expect(r.desc.slice(0, 2)).toEqual(['T-PROMO', 'T-VERIFIED'])
        const rest = r.def.filter(s => !['T-VERIFIED', 'T-PROMO'].includes(s))
        expect(r.asc.slice(2)).toEqual(rest); expect(r.desc.slice(2)).toEqual(rest)        // everything else keeps the default order
        expect(r.all.find(p => p.sku === 'I-INAX')).toMatchObject({ price: null, price_display: 'Liên hệ báo giá' })
    })

    it('PHASE 4: Admin edit -> Public read (DB layer; HTML cache TTL is 45 s, see page-cache.ts)', async () => {
        production(); const m = await load()
        await db.query('begin'); await db.query(`set local role ${ADM}`)
        await db.query("update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=3000000, canonical_price_checked_at=now(), version=version+1 where sku='T-CONTACT'")
        await db.query('commit')
        expect((await m.getLiveProductByCategory('thiet-bi-ve-sinh', 't-contact'))?.price).toBe(3000000)
        await db.query('begin'); await db.query(`set local role ${ADM}`)
        await db.query("update dpg_app.products set regular_price_vnd=null, canonical_price_status=null, canonical_price_checked_at=now(), version=version+1 where sku='T-CONTACT'")
        await db.query('commit')
        expect(await m.getLiveProductByCategory('thiet-bi-ve-sinh', 't-contact')).toMatchObject({ price: null, price_display: 'Cần liên hệ xác nhận giá' })
        // the CHECK stops a status that carries a price
        await expect(sql("update dpg_app.products set canonical_price_status='CONTACT_VERIFIED', regular_price_vnd=5 where sku='T-CONTACT'")).rejects.toThrow()
    })

    it('PHASE 4b: series/variant gate — OFF in Production even when the series grants EXIST; ON only by explicit flag', async () => {
        await sql(`grant select (key) on dpg_app.spec_definitions to ${PUB}; grant select (slug, sort_order) on dpg_app.spec_options to ${PUB};
          insert into dpg_app.spec_definitions(key,label) values ('Bộ sưu tập','Bộ sưu tập'); insert into dpg_app.spec_options(spec_definition_id,value,slug) values (1,'Series X','toto-x');
          insert into dpg_app.product_spec_values(product_id,spec_definition_id,option_id) select id,1,1 from dpg_app.products where sku in ('T-VERIFIED','T-PROMO')`)
        production(); let m = await load(); log.length = 0
        const siblings = await m.getLiveVariantSiblings('G1', 1)
        const facet = await m.getLiveSeriesFacet('thiet-bi-ve-sinh', 'chau-lavabo', ['toto'], ['toto-x'])
        const listing = await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo', 1, 48, { brandSlugs: ['toto'], seriesSlugs: ['toto-x'] })
        const legacy = await (await import('../../../apps/public/src/runtime/canonical-public-api')).getVariantSelectionData('G1', 1)
        expect((legacy.siblings as { sku: string }[]).map(s => s.sku)).toEqual(['T-PROMO'])           // legacy chips survive under the real Production ACL, same brand/sub-category only
        expect(log.join('\n')).not.toMatch(/spec_options|spec_definitions|product_spec_values/); log.length = 0
        expect(siblings).toEqual([]); expect(facet).toMatchObject({ applicable: false, dropped: ['toto-x'] })
        expect(listing.products.length).toBeGreaterThan(2)                                  // series filter ignored (not applied) -> brand filter only
        expect(log.join('\n')).not.toMatch(/spec_options|spec_definitions|product_spec_values/)   // no series/variant statement at all
        vi.stubEnv('PUBLIC_SERIES_VARIANT', 'on'); m = await load(); log.length = 0
        const on = await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo', 1, 48, { brandSlugs: ['toto'], seriesSlugs: ['toto-x'] })
        expect(on.products.map(p => p.sku).sort()).toEqual(['T-PROMO', 'T-VERIFIED'])        // gate ON + grants -> the accepted-later behaviour works
        expect((await m.getLiveSeriesFacet('thiet-bi-ve-sinh', 'chau-lavabo', ['toto'], ['toto-x'])).applicable).toBe(true)
        await sql(`revoke select (key) on dpg_app.spec_definitions from ${PUB}; revoke select (slug, sort_order) on dpg_app.spec_options from ${PUB}`)
    })

    it('PHASE 4c: per-brand release set (TOTO/INAX) x state — inactive SKUs with canonical price never reach Public; INAX only when its brand flag is on', async () => {
        await sql(`insert into dpg_app.products(sku,name,slug,category_id,subcategory_id,brand_id,price,list_price,price_state,is_active,canonical_price_status,regular_price_vnd,canonical_price_checked_at) values
          ('T-INACTIVE','TOTO inactive priced','t-inactive',1,1,1,null,null,'unknown',false,'PRICE_VERIFIED',8100000,now()),
          ('I-INACTIVE','INAX inactive priced','i-inactive',1,1,2,null,null,'unknown',false,'PRICE_VERIFIED',8200000,now());
          update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=7000000, canonical_price_checked_at=now() where sku='I-INAX'`)
        const seen = async (brands: string | undefined) => {
            vi.unstubAllEnvs(); production(); if (brands !== undefined) vi.stubEnv('PUBLIC_CANONICAL_PRICE_BRANDS', brands)
            const m = await load()
            const list = (await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo', 1, 48, {})).products
            const by = Object.fromEntries(list.map(p => [p.sku, p]))
            const search = (await m.searchLiveProducts('INACTIVE', 1, 24)).results
            const pdp = await Promise.all(['t-inactive', 'i-inactive'].map(s => m.getLiveProductByCategory('thiet-bi-ve-sinh', s)))
            const asc = (await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo', 1, 48, { priceSort: 'asc' })).products.map(p => p.sku)
            // Public reads active only: inactive rows are absent from listing / search / PDP (hence SEO/JSON-LD/sitemap) whatever the flags
            expect(list.some(p => p.sku.endsWith('INACTIVE'))).toBe(false); expect(search).toHaveLength(0); expect(pdp).toEqual([null, null])
            expect(JSON.stringify([list, search])).not.toMatch(/8100000|8200000/)
            return { inax: by['I-INAX'], asc }
        }
        expect((await seen(undefined)).inax).toMatchObject({ price: null, price_display: 'Liên hệ báo giá' })          // default = TOTO only
        expect((await seen('toto')).inax).toMatchObject({ price: null, price_display: 'Liên hệ báo giá' })
        const both = await seen('toto,inax'); expect(both.inax).toMatchObject({ price: 7000000, price_provenance: 'hita-exact-v1' })
        expect(both.asc.slice(0, 3)).toEqual(['T-VERIFIED', 'T-PROMO', 'I-INAX'])                                      // INAX joins the verified-price sort only when enabled
        const inaxOnly = await seen('inax'); expect(inaxOnly.inax).toMatchObject({ price: 7000000 })
        vi.unstubAllEnvs(); production(); vi.stubEnv('PUBLIC_CANONICAL_PRICE_BRANDS', 'inax')
        const m = await load(); const toto = (await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo', 1, 48, {})).products.find(p => p.sku === 'T-PROMO')
        expect(toto).toMatchObject({ price: null, price_display: 'Liên hệ báo giá' })                                   // INAX-only release leaves TOTO untouched (legacy path)
        vi.stubEnv('PUBLIC_CANONICAL_PRICE_BRANDS', 'toto,evil,gach'); const m2 = await load()
        expect((await m2.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo', 1, 48, {})).products.find(p => p.sku === 'I-INAX')).toMatchObject({ price: null, price_display: 'Liên hệ báo giá' })   // allowlist ∩ env
        await sql("delete from dpg_app.products where sku in ('T-INACTIVE','I-INACTIVE'); update dpg_app.products set canonical_price_status=null, regular_price_vnd=null, canonical_price_checked_at=null where sku='I-INAX'")
    })

    it('PHASE 4d (2C): REVERIFY_REQUIRED — historical price kept in the row, but listing/search/PDP/sort/offer never show it; Admin verification restores it', async () => {
        await sql(`update dpg_app.products set canonical_price_status='REVERIFY_REQUIRED', regular_price_vnd=6100000, canonical_price_checked_at=now() - interval '30 days' where sku='T-CONTACT';
                   update dpg_app.products set canonical_price_status='REVERIFY_REQUIRED', regular_price_vnd=6200000, promotional_price_vnd=6000000, canonical_price_checked_at=now() - interval '30 days' where sku='I-INAX'`)
        for (const brands of ['toto', 'toto,inax']) {
            vi.unstubAllEnvs(); production(); vi.stubEnv('PUBLIC_CANONICAL_PRICE_BRANDS', brands)
            const m = await load()
            const list = (await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo', 1, 48, {})).products
            const sorted = (await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo', 1, 48, { priceSort: 'desc' })).products
            const pdp = await m.getLiveProductByCategory('thiet-bi-ve-sinh', 't-contact')
            const search = (await m.searchLiveProducts('T-CONTACT', 1, 24)).results
            const hidden = [list.find(p => p.sku === 'T-CONTACT'), pdp, search[0]]
            for (const p of hidden) expect(p).toMatchObject({ price: null, price_display: 'Cần liên hệ xác nhận giá' })
            expect(JSON.stringify([list, sorted, pdp, search])).not.toMatch(/6100000|6200000|6000000/)
            expect(sorted.slice(0, 2).map(p => p.sku)).toEqual(['T-PROMO', 'T-VERIFIED'])           // REVERIFY rows are not in the verified-price sort
        }
        // the Admin verifies again (price saved => PRICE_VERIFIED + fresh checked-at): the price is shown
        await db.query('begin'); await db.query(`set local role ${ADM}`)
        await db.query("update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=6100000, canonical_price_checked_at=now(), version=version+1 where sku='T-CONTACT'")
        await db.query('commit')
        vi.unstubAllEnvs(); production(); const m = await load()
        expect((await m.getLiveProductByCategory('thiet-bi-ve-sinh', 't-contact'))?.price).toBe(6100000)
        await sql("update dpg_app.products set canonical_price_status=null, regular_price_vnd=null, promotional_price_vnd=null, canonical_price_checked_at=null where sku in ('T-CONTACT','I-INAX')")
    })

    it('PHASE 5 (rollback): 002 rollback -> flag ON stays up (fail-safe); flag OFF unaffected; 001 rollback restores the old schema', async () => {
        await sql(`update dpg_app.products set canonical_price_status=null, regular_price_vnd=null, promotional_price_vnd=null, online_voucher_amount_vnd=null, canonical_price_checked_at=null`)
        await sql(await sqlOf(prod('002_canonical_price_grants_rollback.sql')))
        production(); let m = await load()
        const swept = await sweep(m); expect(swept.asc).toEqual(swept.def); expect(swept.desc).toEqual(swept.def)
        const hidden = await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')
        expect(hidden.products.find(p => p.sku === 'T-VERIFIED')).toMatchObject({ price: null, price_display: 'Cần liên hệ xác nhận giá' })
        vi.unstubAllEnvs(); vi.stubEnv('APP_ENV', 'production'); m = await load()
        expect((await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')).totalCount).toBe(6)
        await sql(await sqlOf(prod('001_canonical_price_columns_rollback.sql')))
        production(); m = await load()
        const after = await sweep(m); expect(after.asc).toEqual(after.def)
        expect((await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')).products.every(p => p.price === null)).toBe(true)
    })
})
