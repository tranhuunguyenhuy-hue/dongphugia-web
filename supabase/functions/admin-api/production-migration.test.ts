// @vitest-environment node
// The Production (M4) migrations applied to a Production-shaped database: no products.version, audit_logs without
// request_id/changed_fields, a target contract that forbids writes until the Owner flips it, >= 5000 products.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signEnvelope, routeOf } from './envelope.mjs'
import { handleRequest, type Db } from './handlers.ts'
import { productionMigrationFiles } from './production-migration.ts'

const root = process.cwd()
const integrationUrl = process.env.POSTGRES_SNAPSHOT_INTEGRATION_URL
const loopback = (() => { try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(integrationUrl ?? '').hostname.replace(/^\[|\]$/g, '')) } catch { return false } })()
const SECRET = 'prod-migration-secret-0123456789abcdef', ORIGIN = 'https://www.example.test', BASE = 'https://fn.example.test/functions/v1/admin-api'
const read = (file: string) => readFile(path.join(root, file), 'utf8')

describe('Production migration files', () => {
  it('stay in sync with the resource definitions (regenerate with scripts/m4/generate-production-admin-migration.mts)', async () => {
    for (const [file, content] of productionMigrationFiles()) expect(await read(file), file).toBe(content)
  })
  it('target Production only: no TEST role/ref markers, a Production guard and an Owner-controlled write contract', async () => {
    for (const [file, content] of productionMigrationFiles()) {
      expect(content, file).not.toMatch(/dpg_admin_api_test|m3_admin_api_|uybumsnyqpwcidjxmfsv|preview_synthetic/)
      if (!file.endsWith('_rollback.sql')) expect(content, file).toContain('M4_TARGET_GUARD_FAILED:production_writes_not_authorised')
    }
    expect(productionMigrationFiles()[0][1]).toContain('bonxyxluzlxfkdetryoo')
    expect(productionMigrationFiles()[0][1]).toMatch(/add column if not exists version integer not null default 1/)
  })
})

describe.skipIf(!integrationUrl || !loopback)('Production migrations (M4) on a Production-shaped database', () => {
  const dbName = `admin_prod_${process.pid}_${Date.now()}`
  let owner: Client, pool: Pool
  const db = (): Db => ({
    query: async (text, params = []) => (await pool.query(text, params as unknown[])).rows,
    transaction: async (fn) => {
      const client = await pool.connect()
      const wrap = (c: typeof client): Db => ({ query: async (t, p = []) => (await c.query(t, p as unknown[])).rows, transaction: async () => { throw new Error('nested') } })
      try { await client.query('begin'); const out = await fn(wrap(client)); await client.query('commit'); return out } catch (e) { await client.query('rollback').catch(() => undefined); throw e } finally { client.release() }
    },
  })
  const call = async (method: string, route: string, body?: unknown, token?: string) => {
    const text = body === undefined ? '' : JSON.stringify(body)
    const h = await signEnvelope(SECRET, { method, route: routeOf(BASE + route), body: text, clientIp: '10.0.0.9', origin: ORIGIN, sessionToken: token })
    const r = await handleRequest(new Request(BASE + route, { method, body: text || undefined, headers: h }), { db: db(), hmacSecret: SECRET, allowedOrigin: ORIGIN, allowedMediaHosts: 'media.example.test', verifyPassword: bcrypt.compare, hashPassword: (p) => bcrypt.hash(p, 4) })
    return { status: r.status, json: await r.json() as any }
  }
  // The migrations are explicit transactions: a refused run leaves the session inside an aborted one (the SQL editor starts a fresh session each run).
  const apply = async (file: string) => { try { return await owner.query(await read(file)) } catch (error) { await owner.query('rollback').catch(() => undefined); throw error } }
  const migrate = async () => { await apply('supabase/m4-production/001_m4_production_admin_api_base.sql'); await apply('supabase/m4-production/002_m4_production_admin_resources.sql') }

  beforeAll(async () => {
    const admin = new Client({ connectionString: integrationUrl }); await admin.connect(); await admin.query(`create database ${dbName}`); await admin.end()
    const url = new URL(integrationUrl!); url.pathname = `/${dbName}`
    owner = new Client({ connectionString: url.toString() }); await owner.connect()
    await owner.query(await read('supabase/functions/admin-api/test-fixtures/base.sql'))
    await owner.query(await read('supabase/functions/admin-api/test-fixtures/resources.sql'))
    // Production shape: no products.version, no audit request_id/changed_fields (fixtures already mirror the latter).
    await owner.query('alter table dpg_app.products drop column version')
    await owner.query(`insert into dpg_app.products(sku,name,slug,category_id,price,price_display,image_main_url) select 'P-'||g,'Prod '||g,'prod-'||g,1,1000,'1.000đ','https://media.example.test/p.webp' from generate_series(1,5000) g`)
    await owner.query(`create schema dpg_control; create table dpg_control.target_contract (singleton boolean primary key default true, project_name text, environment text, production_writes_allowed boolean);
      insert into dpg_control.target_contract values (true,'dongphugia-runtime','preview',false)`)
    await owner.query(`do $$ begin create role dpg_public_catalogue nologin; exception when duplicate_object then null; end $$`)
    await owner.query(`insert into dpg_app.admin_users(email,name,password_hash,role,is_active) values ('boss@example.test','Boss',$1,'admin',true)`, [bcrypt.hashSync('boss-pass-123', 4)])
    const apiUrl = new URL(url); pool = new Pool({ connectionString: apiUrl.toString(), max: 4, options: '-c role=dpg_admin_api' })
  }, 90_000)

  afterAll(async () => {
    await pool?.end().catch(() => undefined); await owner?.end()
    const admin = new Client({ connectionString: integrationUrl }); await admin.connect()
    await admin.query(`drop database if exists ${dbName} with (force)`)
    await admin.query('drop owned by dpg_admin_api').catch(() => undefined); await admin.query('drop role if exists dpg_admin_api').catch(() => undefined)
    await admin.query('drop role if exists dpg_public_catalogue').catch(() => undefined); await admin.end()
  })

  it('refuses to run until the Owner has authorised Production writes in the target contract', async () => {
    await expect(apply('supabase/m4-production/001_m4_production_admin_api_base.sql')).rejects.toThrow(/production_writes_not_authorised/)
    await owner.query('update dpg_control.target_contract set production_writes_allowed = true')
  })

  it('also refuses a database that is not the Production catalogue', async () => {
    await owner.query("update dpg_control.target_contract set project_name = 'other'")
    await expect(apply('supabase/m4-production/001_m4_production_admin_api_base.sql')).rejects.toThrow(/project_contract/)
    await owner.query("update dpg_control.target_contract set project_name = 'dongphugia-runtime'")
    await owner.query("create role dpg_public_m3_test nologin")
    await expect(apply('supabase/m4-production/001_m4_production_admin_api_base.sql')).rejects.toThrow(/test_roles_present/)
    await owner.query('drop role dpg_public_m3_test')
  })

  it('fails the schema preflight before changing anything when the database lacks a column', async () => {
    await owner.query('alter table dpg_app.customers rename column notes to notes_missing')
    await expect(apply('supabase/m4-production/002_m4_production_admin_resources.sql')).rejects.toThrow(/ADMIN_SCHEMA_PREFLIGHT_FAILED:columns:.*customers\.notes/)
    await owner.query('alter table dpg_app.customers rename column notes_missing to notes')
    expect((await owner.query("select 1 from pg_roles where rolname='dpg_admin_api'")).rows).toHaveLength(0) // nothing was applied
  })

  it('applies idempotently and the API works on the Production schema (products.version added, base-shape audit rows)', async () => {
    await migrate(); await migrate()
    expect((await owner.query("select column_name from information_schema.columns where table_schema='dpg_app' and table_name='products' and column_name='version'")).rows).toHaveLength(1)
    const login = await call('POST', '/login', { email: 'boss@example.test', password: 'boss-pass-123' })
    expect(login.status).toBe(200); const token = login.json.data.token as string
    const list = await call('GET', '/r/products?limit=5', undefined, token); expect(list.status).toBe(200); expect(list.json.data.total).toBeGreaterThanOrEqual(5000)
    const id = list.json.data.items[0].id
    const edited = await call('PATCH', `/r/products/${id}`, { expected_version: 1, input: { name: 'Đổi tên' } }, token)
    expect(edited.json.data).toMatchObject({ name: 'Đổi tên', version: 2 })
    expect((await call('PATCH', `/r/products/${id}`, { expected_version: 1, input: { name: 'Stale' } }, token)).json.error.code).toBe('VERSION_CONFLICT')
    const created = await call('POST', '/r/blog-tags', { input: { name: 'Tag', slug: 'tag' } }, token); expect(created.status).toBe(201)
    expect((await call('GET', '/dashboard', undefined, token)).status).toBe(200)
    const audit = (await owner.query("select new_value from dpg_app.audit_logs where entity_type='products' and entity_id=$1", [id])).rows
    expect(audit[0].new_value._meta.changed_fields).toEqual(['name'])
    // still least privilege on Production: identity/price/credential columns and tables outside the Admin scope
    for (const statement of ['update dpg_app.products set sku = \'x\'', 'update dpg_app.products set created_at = now()', 'delete from dpg_app.admin_users', 'select * from dpg_app.orders', 'update dpg_app.audit_logs set action = \'x\'', 'delete from dpg_app.audit_logs']) {
      await expect(pool.query(statement), statement).rejects.toThrow(/permission denied/)
    }
  })

  it('rolls back cleanly while keeping products.version', async () => {
    await pool.end()
    await apply('supabase/m4-production/002_m4_production_admin_resources_rollback.sql'); await apply('supabase/m4-production/001_m4_production_admin_api_base_rollback.sql')
    expect((await owner.query("select 1 from pg_roles where rolname='dpg_admin_api'")).rows).toHaveLength(0)
    expect((await owner.query("select 1 from information_schema.tables where table_schema='dpg_app' and table_name in ('admin_api_nonces','admin_api_login_attempts')")).rows).toHaveLength(0)
    expect((await owner.query("select 1 from pg_policies where policyname like 'admin_api_%'")).rows).toHaveLength(0)
    expect((await owner.query("select 1 from information_schema.columns where table_schema='dpg_app' and table_name='products' and column_name='version'")).rows).toHaveLength(1)
    await migrate() // and it can be re-applied after a rollback
  })
})
