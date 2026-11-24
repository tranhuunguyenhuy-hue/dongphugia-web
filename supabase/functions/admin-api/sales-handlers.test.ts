// @vitest-environment node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApiError, type Context, type Db } from './core.ts'
import type { AdminRole } from './permissions.ts'
import { assignSales, getSales, listSales, salesSummary, setSalesNote, setSalesStatus } from './sales-handlers.ts'
import { dashboard } from './commerce-handlers.ts'

// Commerce v1 inbox against a real PostgreSQL: the NEW schema dpg_commerce (001_commerce_schema.sql) filled through the guest intake functions, read/changed through the
// staff handlers running as the least-privilege Admin API role. Skipped unless POSTGRES_SNAPSHOT_INTEGRATION_URL points at a loopback server (CI sets it).
const integrationUrl = process.env.POSTGRES_SNAPSHOT_INTEGRATION_URL
const loopback = (() => { try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(integrationUrl ?? '').hostname.replace(/^\[|\]$/g, '')) } catch { return false } })()
const root = process.cwd()

describe.skipIf(!integrationUrl || !loopback)('commerce v1 staff inbox (PostgreSQL, least-privilege role)', () => {
  const dbName = `sales_${process.pid}_${Date.now()}`, role = `dpg_sales_api_${process.pid}`
  let owner: Client, pool: Pool
  const ids = { admin: 0, manager: 0, sale: 0, other: 0, off: 0 }
  const codes: { order: string[]; quote: string[] } = { order: [], quote: [] }
  const rows: { order: number[]; quote: number[] } = { order: [], quote: [] }

  const db: Db = {
    query: async (text, params = []) => (await pool.query(text, params as unknown[])).rows,
    transaction: async (fn) => {
      const client = await pool.connect()
      const tx: Db = { query: async (text, params = []) => (await client.query(text, params as unknown[])).rows, transaction: async () => { throw new Error('nested') } }
      try { await client.query('begin'); const out = await fn(tx); await client.query('commit'); return out }
      catch (error) { await client.query('rollback').catch(() => undefined); throw error } finally { client.release() }
    },
  }
  const ctx = (who: keyof typeof ids): Context => ({ request_id: 'req-1', ip: '10.0.0.1', session: { sessionId: 1, userId: ids[who], email: `${who}@example.test`, name: who, role: ({ admin: 'admin', manager: 'sale_manager', sale: 'sale', other: 'sale', off: 'sale' } as Record<string, AdminRole>)[who] } })
  const deps = { db }
  const code = async (p: Promise<unknown>) => { try { await p; return 'OK' } catch (e) { return e instanceof ApiError ? e.code : `ERR:${(e as Error).message}` } }
  const body = (value: unknown) => JSON.stringify(value)

  beforeAll(async () => {
    const admin = new Client({ connectionString: integrationUrl }); await admin.connect(); await admin.query(`create database ${dbName}`); await admin.end()
    const url = new URL(integrationUrl!); url.pathname = `/${dbName}`
    owner = new Client({ connectionString: url.toString() }); await owner.connect()
    await owner.query(`
      create schema dpg_app; create schema dpg_control;
      create table dpg_control.target_contract(project_name text, region text, environment text, production_writes_allowed bool, production_data_allowed bool, production_credentials_allowed bool, hard_database_ceiling_bytes bigint);
      insert into dpg_control.target_contract values ('dongphugia-phase2-preview-290','ap-southeast-1','preview_synthetic',false,false,false,367001600);
      create table dpg_app.categories(id serial primary key, slug text, name text); insert into dpg_app.categories(slug,name) values ('thiet-bi-ve-sinh','VS'),('gach-op-lat','Gach');
      create table dpg_app.brands(id serial primary key, slug text, name text); insert into dpg_app.brands(slug,name) values ('toto','TOTO'),('inax','INAX');
      create table dpg_app.products(id serial primary key, sku text, name text, is_active bool default true, publication_status text default 'public', pdp_visibility text default 'public', sellable_status text default 'sellable', stock_status text default 'in_stock',
        category_id int, brand_id int, regular_price_vnd bigint, promotional_price_vnd bigint, online_voucher_amount_vnd bigint, canonical_price_status text);
      insert into dpg_app.products(sku,name,category_id,brand_id,regular_price_vnd,promotional_price_vnd,online_voucher_amount_vnd,canonical_price_status) values
        ('T-1','TOTO 1',1,1,1000000,null,null,'PRICE_VERIFIED'), ('T-2','TOTO 2',1,1,2000000,1800000,100000,'PRICE_VERIFIED'), ('T-3','No price',1,1,null,null,null,null), ('G-1','Gach',2,null,null,null,null,null);
      create table dpg_app.admin_users(id serial primary key, email text, name text, role text, is_active bool default true);
      insert into dpg_app.admin_users(email,name,role,is_active) values ('admin@example.test','admin','admin',true),('manager@example.test','manager','sale_manager',true),('sale@example.test','sale','sale',true),('other@example.test','other','sale',true),('off@example.test','off','sale',false);
      create table dpg_app.audit_logs(id bigserial primary key, user_id int, action text, entity_type text, entity_id int, old_value jsonb, new_value jsonb, ip_address varchar(45), created_at timestamptz default now());
      create role ${role} login password 'pw'; grant usage on schema dpg_app to ${role}; grant select on dpg_app.admin_users to ${role}; grant select (id, is_active) on dpg_app.products to ${role}; grant insert on dpg_app.audit_logs to ${role}; grant usage on sequence dpg_app.audit_logs_id_seq to ${role};
      create role dpg_operator_x; alter role dpg_operator_x createrole;`)
    for (const [k, who] of [['admin', 'admin'], ['manager', 'manager'], ['sale', 'sale'], ['other', 'other'], ['off', 'off']] as const) ids[k] = (await owner.query('select id from dpg_app.admin_users where name=$1', [who])).rows[0].id
    const sql = (await readFile(path.join(root, 'supabase/commerce-v1/001_commerce_schema.sql'), 'utf8')).replaceAll(":'approved_sha'", "'sales-test'").replaceAll(":'target'", "'test'").replaceAll(":'admin_role'", `'${role}'`)
    await owner.query(sql)
    const apiUrl = new URL(url); apiUrl.username = role; apiUrl.password = 'pw'; pool = new Pool({ connectionString: apiUrl.toString(), max: 4 })
    // guests: 3 orders, 2 quotes through the real intake functions
    const guest = async (sqlText: string, params: unknown[]) => { await owner.query('begin'); await owner.query('set local role dpg_commerce_intake'); const r = await owner.query(sqlText, params); await owner.query('commit'); return r.rows[0].r }
    const contact = (n: number) => ({ customerName: `Khach ${n}`, customerPhone: `091200000${n}`, deliveryAddress: `${n} Le Loi, Quan 1`, note: `ghi chu ${n}` })
    const specs: [number, unknown][] = [[1, [{ productId: 1, quantity: 1 }, { productId: 2, quantity: 3 }]], [2, [{ productId: 1, quantity: 2 }]], [3, [{ productId: 2, quantity: 1 }]]]
    const totals = [6_100_000, 2_000_000, 1_700_000]
    for (const [i, [n, items]] of specs.entries()) {
      const r = await guest('select dpg_commerce.order_submit($1::jsonb, $2, $3) r', [JSON.stringify({ ...contact(n), items, expectedTotalVnd: totals[i] }), `idem-sales-order-${n}`, `ab${n}`.padEnd(32, 'a')])
      expect(r.ok).toBe(true); codes.order.push(r.code)
    }
    for (const n of [4, 5]) {
      const r = await guest('select dpg_commerce.quote_submit($1::jsonb, $2, $3) r', [JSON.stringify({ ...contact(n), items: [{ productId: 3, quantity: 2 }, { productId: 4, quantity: 1 }] }), `idem-sales-quote-${n}`, `cd${n}`.padEnd(32, 'c')])
      expect(r.ok).toBe(true); codes.quote.push(r.code)
    }
    rows.order = (await owner.query('select id from dpg_commerce.orders order by id')).rows.map((r) => Number(r.id)); rows.quote = (await owner.query('select id from dpg_commerce.quotes order by id')).rows.map((r) => Number(r.id))
  }, 60_000)
  afterAll(async () => {
    await pool?.end(); await owner?.end()
    const admin = new Client({ connectionString: integrationUrl }); await admin.connect(); await admin.query(`drop database if exists ${dbName} with (force)`)
    for (const r of [role, 'dpg_operator_x', 'dpg_commerce_intake', 'dpg_commerce_owner']) await admin.query(`drop role if exists ${r}`).catch(() => undefined); await admin.end()
  })

  it('lists and reads the exact snapshot a guest submitted (lines, prices, voucher once, events) — never legacy tables', async () => {
    const list = (await listSales(deps, ctx('admin'), 'orders', new URLSearchParams())).body as any
    expect(list.data.total).toBe(3); expect(list.data.counts).toEqual({ new: 3, processing: 0, done: 0, cancelled: 0 })
    expect(list.data.items.map((i: any) => i.total_vnd).sort()).toEqual([1_700_000, 2_000_000, 6_100_000])
    const one = (await getSales(deps, ctx('admin'), 'orders', rows.order[0])).body as any
    expect(one.data).toMatchObject({ code: codes.order[0], status: 'new', subtotal_vnd: 6_400_000, voucher_vnd: 300_000, total_vnd: 6_100_000, customer_name: 'Khach 1', delivery_address: '1 Le Loi, Quan 1' })
    expect(one.data.lines).toHaveLength(2); expect(one.data.lines[1]).toMatchObject({ quantity: 3, unit_selling_vnd: 1_800_000, unit_voucher_vnd: 100_000, line_voucher_vnd: 300_000 })
    expect(one.data.events).toMatchObject([{ actor: 'guest', action: 'created', to_status: 'new' }])
    const quote = (await getSales(deps, ctx('admin'), 'quotes', rows.quote[0])).body as any
    expect(quote.data.lines).toMatchObject([{ reason: 'NO_PRICE', unit_selling_vnd: null, quantity: 2 }, { reason: 'NO_PRICE', unit_selling_vnd: null }])   // NULL stays NULL, never 0
  })
  it('search and filters are parameterised; bad input is rejected', async () => {
    expect(((await listSales(deps, ctx('admin'), 'orders', new URLSearchParams({ q: "x'; drop table dpg_commerce.orders;--" }))).body as any).data.total).toBe(0)
    expect(((await listSales(deps, ctx('admin'), 'orders', new URLSearchParams({ q: 'Khach 2' }))).body as any).data.items[0].customer_name).toBe('Khach 2')
    expect(((await listSales(deps, ctx('admin'), 'orders', new URLSearchParams({ q: codes.order[2] }))).body as any).data.total).toBe(1)
    expect(await code(listSales(deps, ctx('admin'), 'orders', new URLSearchParams({ status: 'paid' })))).toBe('VALIDATION_FAILED')
    expect(await code(getSales(deps, ctx('admin'), 'orders', 0))).toBe('NOT_FOUND'); expect(await code(getSales(deps, ctx('admin'), 'orders', 987654))).toBe('NOT_FOUND')
    expect(((await listSales(deps, ctx('admin'), 'orders', new URLSearchParams({ limit: '2', page: '2' }))).body as any).data.items).toHaveLength(1)
  })
  it('RBAC: a sale user sees only records assigned to them; others look absent; unauthenticated is 401', async () => {
    expect(((await listSales(deps, ctx('sale'), 'orders', new URLSearchParams())).body as any).data.total).toBe(0)
    expect(await code(getSales(deps, ctx('sale'), 'orders', rows.order[0]))).toBe('NOT_FOUND')
    expect(await code(listSales(deps, { request_id: 'x', ip: '' }, 'orders', new URLSearchParams()))).toBe('UNAUTHENTICATED')
    expect(await code(assignSales(deps, ctx('sale'), 'orders', rows.order[0], body({ user_id: ids.sale, expected_version: 1 })))).toBe('NOT_FOUND')     // cannot even touch an unassigned record
    expect(await code(assignSales(deps, ctx('manager'), 'orders', rows.order[0], body({ user_id: ids.off, expected_version: 1 })))).toBe('VALIDATION_FAILED')   // inactive staff
    expect(await code(assignSales(deps, ctx('manager'), 'orders', rows.order[0], body({ user_id: 99999, expected_version: 1 })))).toBe('VALIDATION_FAILED')
    expect(((await assignSales(deps, ctx('manager'), 'orders', rows.order[0], body({ user_id: ids.sale, expected_version: 1 }))).body as any).data).toMatchObject({ assigned_to: ids.sale, version: 2 })
    expect(((await listSales(deps, ctx('sale'), 'orders', new URLSearchParams())).body as any).data.total).toBe(1)
    expect(await code(getSales(deps, ctx('other'), 'orders', rows.order[0]))).toBe('NOT_FOUND')
    expect(await code(assignSales(deps, ctx('sale'), 'orders', rows.order[0], body({ user_id: null, expected_version: 2 })))).toBe('FORBIDDEN')     // sale cannot reassign
  })
  it('status machine: new -> processing -> done; cancel needs its permission; terminal never changes; stale version = 409; every change is audited with an event', async () => {
    const id = rows.order[0]
    expect(await code(setSalesStatus(deps, ctx('admin'), 'orders', id, body({ status: 'new', expected_version: 2 })))).toBe('VALIDATION_FAILED')
    expect(await code(setSalesStatus(deps, ctx('admin'), 'orders', id, body({ status: 'done', expected_version: 2 })))).toBe('STATUS_TRANSITION_INVALID')   // new -> done is refused by the database trigger
    expect(await code(setSalesStatus(deps, ctx('admin'), 'orders', id, body({ status: 'paid', expected_version: 2 })))).toBe('VALIDATION_FAILED')   // there is no "paid": payment happens outside the system
    expect(await code(setSalesStatus(deps, ctx('admin'), 'orders', id, body({ status: 'processing', expected_version: 1 })))).toBe('VERSION_CONFLICT')
    expect(await code(setSalesStatus(deps, ctx('sale'), 'orders', id, body({ status: 'cancelled', expected_version: 2 })))).toBe('FORBIDDEN')           // orders:cancel is manager/admin only
    const processing = (await setSalesStatus(deps, ctx('sale'), 'orders', id, body({ status: 'processing', note: 'Da goi khach', expected_version: 2 }))).body as any
    expect(processing.data).toMatchObject({ status: 'processing', staff_note: 'Da goi khach', version: 3 })
    const done = (await setSalesStatus(deps, ctx('sale'), 'orders', id, body({ status: 'done', expected_version: 3 }))).body as any
    expect(done.data.status).toBe('done')
    expect(await code(setSalesStatus(deps, ctx('admin'), 'orders', id, body({ status: 'cancelled', expected_version: 4 })))).toBe('STATUS_TRANSITION_INVALID')   // terminal
    const events = (await owner.query("select actor, action, from_status, to_status from dpg_commerce.events where entity='order' and entity_id=$1 order by id", [id])).rows
    expect(events).toEqual([{ actor: 'guest', action: 'created', from_status: null, to_status: 'new' }, { actor: `admin:${ids.manager}`, action: 'assign', from_status: null, to_status: null }, { actor: `admin:${ids.sale}`, action: 'status', from_status: 'new', to_status: 'processing' }, { actor: `admin:${ids.sale}`, action: 'status', from_status: 'processing', to_status: 'done' }])
    const audit = (await owner.query("select action, user_id from dpg_app.audit_logs where entity_type='commerce_orders' and entity_id=$1 order by id", [id])).rows.map((r) => r.action)
    expect(audit).toEqual(['commerce_orders.assign', 'commerce_orders.status', 'commerce_orders.status'])
    // the totals and customer data of a stored order never change through the staff path
    expect((await owner.query('select total_vnd, customer_phone from dpg_commerce.orders where id=$1', [id])).rows[0]).toEqual({ total_vnd: '6100000', customer_phone: '0912000001' })
  })
  it('manager cancels an order; notes work; quotes follow the same machine', async () => {
    const id = rows.order[1]
    expect(((await setSalesStatus(deps, ctx('manager'), 'orders', id, body({ status: 'cancelled', note: 'Khach doi y', expected_version: 1 }))).body as any).data).toMatchObject({ status: 'cancelled', staff_note: 'Khach doi y' })
    expect(((await setSalesNote(deps, ctx('manager'), 'orders', rows.order[2], body({ note: ' Luu y giao sang ', expected_version: 1 }))).body as any).data.staff_note).toBe('Luu y giao sang')
    expect(await code(setSalesNote(deps, ctx('manager'), 'orders', rows.order[2], body({ note: 'x'.repeat(2001), expected_version: 2 })))).toBe('VALIDATION_FAILED')
    const q = rows.quote[0]
    expect(((await setSalesStatus(deps, ctx('manager'), 'quotes', q, body({ status: 'processing', expected_version: 1 }))).body as any).data.status).toBe('processing')
    expect(((await setSalesStatus(deps, ctx('manager'), 'quotes', q, body({ status: 'done', note: 'Da bao gia qua Zalo', expected_version: 2 }))).body as any).data).toMatchObject({ status: 'done', staff_note: 'Da bao gia qua Zalo' })
    expect(await code(setSalesStatus(deps, ctx('manager'), 'quotes', q, body({ status: 'processing', expected_version: 3 })))).toBe('STATUS_TRANSITION_INVALID')
  })
  it('concurrent updates: exactly one wins, the other gets VERSION_CONFLICT (no lost update)', async () => {
    const id = rows.order[2]
    const results = await Promise.all([1, 2].map(() => code(setSalesStatus(deps, ctx('admin'), 'orders', id, body({ status: 'processing', expected_version: 2 })))))
    expect(results.sort()).toEqual(['OK', expect.stringMatching(/^(VERSION_CONFLICT|STATUS_TRANSITION_INVALID)$/)].sort())
    expect((await owner.query('select status from dpg_commerce.orders where id=$1', [id])).rows[0].status).toBe('processing')
  })
  it('the staff role cannot do anything the handlers do not do (no totals, no customer data, no lines, no deletes) and cannot see legacy tables', async () => {
    for (const statement of ['update dpg_commerce.orders set total_vnd = 1', "update dpg_commerce.orders set customer_phone = '0900000000'", 'update dpg_commerce.order_lines set quantity = 99', 'delete from dpg_commerce.orders', 'delete from dpg_commerce.events',
      "insert into dpg_commerce.orders(code,customer_name,customer_phone,delivery_address,subtotal_vnd,total_vnd,line_count,idempotency_hash,request_hash) values ('DH-AAAAAAAAAA','x','0912345678','y',1,1,1,repeat('a',64),repeat('a',64))", "insert into dpg_commerce.events(entity,entity_id,actor,action) values ('order',1,'guest','status')",
      'select dpg_commerce.order_submit(\'{}\'::jsonb, \'idem-1234567\', \'aaaaaaaaaaaaaaaa\')', 'select * from dpg_commerce.rate_buckets', 'select * from dpg_app.orders'])
      await expect(pool.query(statement), statement).rejects.toThrow(/permission denied|row-level security|does not exist/)
  })
  it('dashboard and summary count what is waiting (no revenue/payment claims)', async () => {
    const d = (await dashboard(deps, ctx('admin'))).body as any
    expect(d.data.stats.new_orders + d.data.stats.processing_orders).toBeGreaterThan(0)
    expect(Object.keys(d.data.stats).join()).not.toMatch(/revenue|paid|payment/i)
    const s = (await salesSummary(deps, ctx('manager'))).body as any
    expect(s.data.new_quotes).toBe(1); expect(typeof s.data.new_orders).toBe('number')
    expect(await code(dashboard(deps, ctx('sale')))).toBe('FORBIDDEN')
  })
})
