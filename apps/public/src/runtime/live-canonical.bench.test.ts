/* eslint-disable @typescript-eslint/no-explicit-any */
// @vitest-environment node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// #470 local benchmark of the live read statements before/after (flag OFF vs ON). LOCAL ONLY: single PostgreSQL 16 on a shared sandbox,
// synthetic data shaped like Production (17,752 products, 16,447 sanitary). It shows plan shape / relative cost, NOT live latency.
const url = process.env.POSTGRES_SNAPSHOT_INTEGRATION_URL
const run = url && process.env.LIVE_CANONICAL_BENCH === '1' ? describe : describe.skip
const root = path.resolve(__dirname, '../../../..')
const sqlOf = async (file: string) => roleNames((await readFile(path.join(root, 'supabase/prod-prep/470', file), 'utf8')).replaceAll(":'approved_sha'", "'bench'"))
let admin: Client, db: Client, dbName = ''
const tag = Math.random().toString(36).slice(2, 8)
const PUB = `dpg_public_catalogue_${tag}`, ADM = `dpg_admin_api_${tag}`, RUN = `dpg_runtime_${tag}`, OPR = `dpg_operator470_${tag}`
const roleNames = (text: string) => text.replaceAll('dpg_public_catalogue', PUB).replaceAll('dpg_admin_api', ADM).replaceAll('dpg_runtime', RUN).replaceAll('dpg_operator470', OPR)
const captured: { name: string; sql: string; values: unknown[] }[] = []
let currentName = ''
vi.mock('./public-db', () => ({ readPublicRows: async (sql: string, values: unknown[]) => { captured.push({ name: currentName, sql, values: [...values] }); return [] } }))
const load = async () => { vi.resetModules(); return import('./live-public-catalogue') }
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

run('benchmark', () => {
    beforeAll(async () => {
        admin = new Client({ connectionString: url }); await admin.connect()
        dbName = 'live_bench_' + Math.random().toString(36).slice(2, 8); await admin.query(`create database ${dbName}`)
        const u = new URL(url!); u.pathname = '/' + dbName; db = new Client({ connectionString: u.toString() }); await db.connect()
        await db.query(roleNames(await readFile(path.join(__dirname, 'test-fixtures/live-public-schema.sql'), 'utf8')))
        await db.query(`insert into dpg_app.categories(slug,name) values ('thiet-bi-ve-sinh','VS'),('thiet-bi-bep','Bep'),('vat-lieu-nuoc','VLN'),('gach-op-lat','Gach');
          insert into dpg_app.subcategories(category_id,slug,name) select c.id, 'sub-'||g, 'Sub '||g from dpg_app.categories c, generate_series(1,6) g;
          insert into dpg_app.brands(slug,name) values ('toto','TOTO'),('inax','INAX'),('caesar','Caesar'),('other','Other');
          insert into dpg_app.products(sku,name,slug,category_id,subcategory_id,brand_id,description,price,list_price,sale_price,price_state,sort_order,listing_priority,variant_group)
          select 'SKU'||g, 'San pham '||g, 'san-pham-'||g,
                 case when g<=16447 then 1 else 2+(g%3) end,
                 (select s.id from dpg_app.subcategories s where s.category_id = case when g<=16447 then 1 else 2+(g%3) end order by s.id offset (g%6) limit 1),
                 1+(g%4), repeat('mo ta ',20), 1000000+g, 1000000+g, null, 'priced', g%50, g%7, case when g%5=0 then 'G'||(g/5) end
          from generate_series(1,17752) g;`)
        await db.query(await sqlOf('001_canonical_price_columns.sql')); await db.query(await sqlOf('002_canonical_price_grants.sql'))
        // TOTO active in sanitary: ~2,057 verified/contact/unresolved rows (brand_id 1)
        await db.query(`update dpg_app.products set canonical_price_status = case when id%10<7 then 'PRICE_VERIFIED' when id%10<9 then 'CONTACT_VERIFIED' else 'UNRESOLVED' end,
            regular_price_vnd = case when id%10<7 then 2000000+id else null end, promotional_price_vnd = case when id%20<5 then 1500000+id else null end,
            online_voucher_amount_vnd = case when id%40<3 then 50000 else null end, canonical_price_checked_at=now()
          where id in (select id from dpg_app.products where category_id=1 and brand_id=1 order by id limit 2057)`)
        await db.query('analyze')
    }, 120_000)
    afterAll(async () => {
        await db?.end(); if (dbName) await admin.query(`drop database if exists ${dbName} with (force)`)
        for (const role of [PUB, ADM, RUN, OPR]) await admin.query(`drop role if exists ${role}`).catch(() => undefined)
        await admin?.end()
    })

    it('plans, query counts and timings (flag OFF vs ON)', async () => {
        const scenarios: Record<string, (m: Awaited<ReturnType<typeof load>>) => Promise<unknown>> = {
            'PLP default (sanitary sub-1, page 1)': m => m.getLiveListing('thiet-bi-ve-sinh', 'sub-1', 1, 48),
            'PLP price sort asc': m => m.getLiveListing('thiet-bi-ve-sinh', 'sub-1', 1, 48, { priceSort: 'asc' }),
            'PLP other category (gach)': m => m.getLiveListing('gach-op-lat', 'sub-1', 1, 48),
            'PDP by slug': m => m.getLiveProductByCategory('thiet-bi-ve-sinh', 'san-pham-1'),
            'search "SKU12"': m => m.searchLiveProducts('SKU12', 1, 24),
            'category root preview': m => m.getLiveListingPreview('thiet-bi-ve-sinh', 'sub-1'),
        }
        const out: Record<string, unknown> = {}
        for (const [name, fn] of Object.entries(scenarios)) {
            const row: Record<string, unknown> = {}
            for (const mode of ['OFF', 'ON']) {
                vi.unstubAllEnvs(); vi.stubEnv('APP_ENV', 'production'); if (mode === 'ON') vi.stubEnv('PUBLIC_CANONICAL_PRICING', 'on')
                const m = await load(); captured.length = 0; currentName = name; await fn(m)
                const q = captured[0]; const times: number[] = []; let plan: Record<string, any>
                for (let i = 0; i < 25; i++) {
                    await db.query('begin read only'); await db.query(`set local role ${PUB}`)
                    const r = await db.query('explain (analyze, buffers, format json) ' + q.sql, q.values)
                    await db.query('rollback'); plan = r.rows[0]['QUERY PLAN'][0]; times.push(plan['Execution Time'])
                }
                const nodes: string[] = []; const walk = (n: any) => { nodes.push(n['Node Type'] + (n['Relation Name'] ? ':' + n['Relation Name'] : '')); (n.Plans ?? []).forEach(walk) }; walk(plan.Plan)
                row[mode] = { statements: captured.length, medianMs: +median(times).toFixed(2), planningMs: +plan['Planning Time'].toFixed(2), sharedHitBlocks: plan.Plan['Shared Hit Blocks'], seqScans: nodes.filter(n => n.startsWith('Seq Scan')).length, nodes: [...new Set(nodes)].slice(0, 8) }
            }
            out[name] = row
        }
        if (process.env.BENCH_OUT) await writeFile(process.env.BENCH_OUT, JSON.stringify(out, null, 2))
        console.log('BENCH ' + JSON.stringify(out))
        for (const row of Object.values(out) as any[]) expect(row.ON.statements).toBe(1)
    }, 300_000)
})
