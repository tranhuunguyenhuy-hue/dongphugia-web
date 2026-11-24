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
    readPublicRows: async (sql: string, values: readonly unknown[]) => {
        log.push(sql)
        await db.query('begin read only'); await db.query(`set local role ${PUB}`)
        try { return (await db.query(sql, values as unknown[])).rows } finally { await db.query('rollback') }
    },
}))
const load = async () => { vi.resetModules(); return import('../../../apps/public/src/runtime/live-public-catalogue') }
const production = () => { vi.stubEnv('APP_ENV', 'production'); vi.stubEnv('PUBLIC_CANONICAL_PRICING', 'on') }
const sql = (text: string) => db.query(text)

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

    it('PHASE 3b: ordering — verified prices first, price sort asc/desc only on verified values, rest last', async () => {
        production(); const m = await load()
        const asc = (await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo', 1, 48, { priceSort: 'asc' })).products.map(p => p.sku)
        expect(asc.slice(0, 2)).toEqual(['T-VERIFIED', 'T-PROMO'])           // 1,000,000 then 1,800,000
        const desc = (await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo', 1, 48, { priceSort: 'desc' })).products.map(p => p.sku)
        expect(desc.slice(0, 2)).toEqual(['T-PROMO', 'T-VERIFIED'])
        for (const order of [asc, desc]) expect(order.slice(2)).toEqual(expect.arrayContaining(['T-CONTACT', 'T-NOSTATUS', 'T-UNRESOLVED', 'I-INAX']))
        const def = (await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')).products.map(p => p.sku)
        expect(new Set(def.slice(0, 2))).toEqual(new Set(['T-VERIFIED', 'T-PROMO']))
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

    it('PHASE 5 (rollback): 002 rollback -> flag ON stays up (fail-safe); flag OFF unaffected; 001 rollback restores the old schema', async () => {
        await sql(`update dpg_app.products set canonical_price_status=null, regular_price_vnd=null, promotional_price_vnd=null, online_voucher_amount_vnd=null, canonical_price_checked_at=null`)
        await sql(await sqlOf(prod('002_canonical_price_grants_rollback.sql')))
        production(); let m = await load()
        const hidden = await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')
        expect(hidden.products.find(p => p.sku === 'T-VERIFIED')).toMatchObject({ price: null, price_display: 'Cần liên hệ xác nhận giá' })
        vi.unstubAllEnvs(); vi.stubEnv('APP_ENV', 'production'); m = await load()
        expect((await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')).totalCount).toBe(6)
        await sql(await sqlOf(prod('001_canonical_price_columns_rollback.sql')))
        production(); m = await load()
        expect((await m.getLiveListing('thiet-bi-ve-sinh', 'chau-lavabo')).products.every(p => p.price === null)).toBe(true)
    })
})
