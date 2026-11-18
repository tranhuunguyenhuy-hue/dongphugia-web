// @vitest-environment node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signEnvelope, verifyEnvelope, randomNonce, routeOf } from './envelope.mjs'
import { handleRequest, DUMMY_HASH, type Db } from './handlers.ts'
import { can, type AdminRole } from './permissions.ts'

const root = process.cwd()
const integrationUrl = process.env.POSTGRES_SNAPSHOT_INTEGRATION_URL
const loopback = (() => { try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(integrationUrl ?? '').hostname.replace(/^\[|\]$/g, '')) } catch { return false } })()
const SECRET = 'test-hmac-secret-0123456789abcdef'
const ORIGIN = 'https://staging.example.test'
const BASE = 'https://fn.example.test/functions/v1/admin-api'

describe('permissions copy', () => {
  it('stays identical to the application source of truth', async () => {
    const [copy, source] = await Promise.all([
      readFile(path.join(root, 'supabase/functions/admin-api/permissions.ts'), 'utf8'),
      readFile(path.join(root, 'src/lib/auth/permissions.ts'), 'utf8'),
    ])
    expect(copy).toBe(source)
  })
})

describe('request envelope', () => {
  const base = { method: 'POST', route: '/login', body: '{"a":1}', clientIp: '1.2.3.4', origin: ORIGIN, sessionToken: 'a'.repeat(64) }
  const headersOf = (h: Record<string, string>) => new Headers(h)
  it('accepts a freshly signed request', async () => {
    const h = await signEnvelope(SECRET, base)
    expect(await verifyEnvelope(SECRET, { ...base, headers: headersOf(h) })).toMatchObject({ ok: true, clientIp: '1.2.3.4', origin: ORIGIN })
  })
  it('rejects tampering with any signed field, wrong secret, stale and malformed headers', async () => {
    const h = await signEnvelope(SECRET, base)
    for (const change of [{ method: 'PATCH' }, { route: '/logout' }, { body: '{"a":2}' }] as const) {
      expect(await verifyEnvelope(SECRET, { ...base, ...change, headers: headersOf(h) })).toMatchObject({ ok: false, code: 'INVALID_SIGNATURE' })
    }
    expect(await verifyEnvelope(SECRET, { ...base, headers: headersOf({ ...h, 'x-dpg-ip': '9.9.9.9' }) })).toMatchObject({ ok: false })
    expect(await verifyEnvelope(SECRET, { ...base, headers: headersOf({ ...h, 'x-dpg-origin': 'https://evil.example' }) })).toMatchObject({ ok: false })
    expect(await verifyEnvelope(SECRET, { ...base, headers: headersOf({ ...h, 'x-dpg-session': 'b'.repeat(64) }) })).toMatchObject({ ok: false })
    expect(await verifyEnvelope('other-secret', { ...base, headers: headersOf(h) })).toMatchObject({ ok: false })
    expect(await verifyEnvelope('', { ...base, headers: headersOf(h) })).toMatchObject({ ok: false })
    expect(await verifyEnvelope(SECRET, { ...base, headers: headersOf(h), now: Date.now() + 61_000 })).toMatchObject({ ok: false, code: 'EXPIRED_REQUEST' })
    expect(await verifyEnvelope(SECRET, { ...base, headers: headersOf(h), now: Date.now() - 61_000 })).toMatchObject({ ok: false, code: 'EXPIRED_REQUEST' })
    expect(await verifyEnvelope(SECRET, { ...base, headers: headersOf({ ...h, 'x-dpg-nonce': 'zz' }) })).toMatchObject({ ok: false })
  })
})

describe.skipIf(!integrationUrl || !loopback)('admin-api against PostgreSQL with the least-privilege role', () => {
  const dbName = `admin_api_${process.pid}_${Date.now()}`
  const apiPassword = 'api-test-password'
  let superUrl: string, apiPool: Pool, owner: Client, apiRole = 'dpg_admin_api_test'
  const passwords: Record<string, string> = {}
  let hashes: Record<string, string>

  const dbOf = (pool: Pool): Db => {
    const make = (client: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }): Db => ({
      query: async (text, params = []) => (await client.query(text, params as unknown[])).rows,
      transaction: async () => { throw new Error('nested') },
    })
    return {
      query: async (text, params = []) => (await pool.query(text, params as unknown[])).rows,
      transaction: async (fn) => {
        const client = await pool.connect()
        try { await client.query('begin'); const out = await fn(make(client)); await client.query('commit'); return out }
        catch (error) { await client.query('rollback').catch(() => undefined); throw error } finally { client.release() }
      },
    }
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString: integrationUrl }); await admin.connect()
    await admin.query(`create database ${dbName}`); await admin.end()
    const url = new URL(integrationUrl!); url.pathname = `/${dbName}`; superUrl = url.toString()
    owner = new Client({ connectionString: superUrl }); await owner.connect()
    hashes = {
      admin: bcrypt.hashSync('admin-pass-1', 4), manager: bcrypt.hashSync('manager-pass-1', 4),
      sale: bcrypt.hashSync('sale-pass-1', 4), off: bcrypt.hashSync('off-pass-1', 4),
    }
    await owner.query(`
      create schema dpg_app;
      create table dpg_app.admin_users (id serial primary key, email varchar not null, name varchar not null, password_hash varchar not null, role varchar, is_active boolean default true, avatar_url varchar, last_login_at timestamptz, created_at timestamptz default now(), updated_at timestamptz, username varchar, supabase_auth_user_id uuid);
      create table dpg_app.admin_sessions (id serial primary key, user_id int not null references dpg_app.admin_users(id), token_hash varchar not null, ip_address varchar, user_agent text, expires_at timestamptz not null, created_at timestamptz default now());
      create table dpg_app.audit_logs (id serial primary key, user_id int, action varchar not null, entity_type varchar not null, entity_id int, old_value jsonb, new_value jsonb, ip_address varchar, created_at timestamptz default now(), auth_user_id uuid, auth_session_id uuid, request_id uuid, idempotency_key_hash char(64), changed_fields text[]);
      create table dpg_app.categories (id serial primary key, name varchar not null, slug varchar not null, is_active boolean default true);
      create table dpg_app.subcategories (id serial primary key, category_id int not null, name varchar not null, slug varchar not null, is_active boolean default true);
      create table dpg_app.brands (id serial primary key, name varchar not null, slug varchar not null, is_active boolean default true);
      create table dpg_app.products (id serial primary key, sku varchar not null, name varchar not null, slug varchar not null, category_id int not null, subcategory_id int, brand_id int, price numeric, price_display varchar, description text, display_name varchar, image_main_url varchar, is_active boolean default true, is_featured boolean default false, publication_status varchar default 'draft', pdp_visibility varchar default 'public', listing_visibility varchar default 'default', search_visibility varchar default 'visible', seo_title varchar, seo_description varchar, updated_at timestamptz default now(), version int default 1, list_price numeric);
      create table dpg_app.orders (id serial primary key);
      alter table dpg_app.admin_users enable row level security; alter table dpg_app.admin_sessions enable row level security; alter table dpg_app.audit_logs enable row level security;
      alter table dpg_app.products enable row level security; alter table dpg_app.categories enable row level security; alter table dpg_app.subcategories enable row level security; alter table dpg_app.brands enable row level security; alter table dpg_app.orders enable row level security;
      insert into dpg_app.categories(name,slug) values ('Cat','cat'); insert into dpg_app.subcategories(category_id,name,slug) values (1,'Sub','sub'); insert into dpg_app.brands(name,slug) values ('Brand','brand');
      insert into dpg_app.products(sku,name,slug,category_id,subcategory_id,brand_id,price,list_price,publication_status) select 'SKU-'||g,'Product '||g,'product-'||g,1,1,1,1000*g,2000*g,'public' from generate_series(1,30) g;`)
    await owner.query(`insert into dpg_app.admin_users(email,name,password_hash,role,is_active) values
      ('admin@example.test','Admin',$1,'admin',true),('manager@example.test','Manager',$2,'sale_manager',true),('sale@example.test','Sale',$3,'sale',true),('off@example.test','Off',$4,'admin',false)`,
      [hashes.admin, hashes.manager, hashes.sale, hashes.off])
    // Real migration minus its target guard (guard needs the TEST-only dpg_control schema).
    const sql = (await readFile(path.join(root, 'supabase/m3-test/004_m3_test_admin_api.sql'), 'utf8')).replace(/-- guard:begin[\s\S]*?-- guard:end\n/, '')
    await owner.query(`drop role if exists ${apiRole}`).catch(() => undefined)
    await owner.query(sql)
    // Generic Admin resources: real table shapes + the generated grants/policies (guard needs the TEST-only schema).
    await owner.query(await readFile(path.join(root, 'supabase/functions/admin-api/test-fixtures/resources.sql'), 'utf8'))
    await owner.query((await readFile(path.join(root, 'supabase/m3-test/005_m3_test_admin_resources.sql'), 'utf8')).replace(/-- guard:begin[\s\S]*?-- guard:end\n/, ''))
    await owner.query(`alter role ${apiRole} password '${apiPassword}'`)
    const apiUrl = new URL(superUrl); apiUrl.username = apiRole; apiUrl.password = apiPassword
    apiPool = new Pool({ connectionString: apiUrl.toString(), max: 4 })
  }, 60_000)

  afterAll(async () => {
    await apiPool?.end(); await owner?.end()
    const admin = new Client({ connectionString: integrationUrl }); await admin.connect()
    await admin.query(`drop database if exists ${dbName} with (force)`)
    // The cluster-level role may legitimately still own grants in another local database; ignore that.
    await admin.query(`drop role if exists ${apiRole}`).catch(() => undefined); await admin.end()
  })

  const deps = () => ({
    db: dbOf(apiPool), hmacSecret: SECRET, allowedOrigin: ORIGIN, allowedMediaHosts: 'media.example.test',
    verifyPassword: (plain: string, hash: string) => bcrypt.compare(plain, hash),
  })
  async function call(method: string, route: string, body?: unknown, opts: { token?: string; ip?: string; origin?: string; headers?: Record<string, string>; nonce?: string; secret?: string } = {}) {
    const text = body === undefined ? '' : JSON.stringify(body)
    const h = await signEnvelope(opts.secret ?? SECRET, { method, route: routeOf(BASE + route), body: text, clientIp: opts.ip ?? '10.0.0.1', origin: opts.origin ?? ORIGIN, sessionToken: opts.token, nonce: opts.nonce })
    const response = await handleRequest(new Request(BASE + route, { method, body: text || undefined, headers: { ...h, ...(opts.headers ?? {}) } }), deps())
    return { status: response.status, json: await response.json() as any, headers: response.headers }
  }
  const loginAs = async (email: string, password: string, ip = '10.0.0.2') => call('POST', '/login', { email, password }, { ip })
  const token = async (who: 'admin' | 'manager' | 'sale') => {
    const creds = { admin: ['admin@example.test', 'admin-pass-1'], manager: ['manager@example.test', 'manager-pass-1'], sale: ['sale@example.test', 'sale-pass-1'] }[who]
    const r = await loginAs(creds[0], creds[1], `10.1.${who.length}.1`); expect(r.status).toBe(200); return r.json.data.token as string
  }

  it('rejects unsigned, wrongly signed and replayed requests', async () => {
    const unsigned = await handleRequest(new Request(BASE + '/me'), deps()); expect(unsigned.status).toBe(401)
    expect((await call('GET', '/me', undefined, { secret: 'wrong' })).json.error.code).toBe('INVALID_SIGNATURE')
    const nonce = randomNonce()
    expect((await call('GET', '/products', undefined, { nonce })).status).toBe(401) // unauthenticated but nonce consumed
    expect((await call('GET', '/products', undefined, { nonce })).json.error.code).toBe('REPLAYED_REQUEST')
  })

  it('requires the gateway-verified origin marker for mutations', async () => {
    expect((await call('POST', '/logout', {}, { origin: 'https://evil.example' })).json.error.code).toBe('ORIGIN_NOT_ALLOWED')
    expect((await call('POST', '/login', { email: 'a@b.co', password: 'x' }, { origin: '' })).json.error.code).toBe('ORIGIN_NOT_ALLOWED')
  })

  it('logs in with bcrypt, stores only the token hash, and revokes on logout', async () => {
    const r = await loginAs('admin@example.test', 'admin-pass-1', '10.9.9.1')
    expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store')
    const tokenValue: string = r.json.data.token; expect(tokenValue).toMatch(/^[0-9a-f]{64}$/); expect(r.json.data.user).toMatchObject({ role: 'admin', email: 'admin@example.test' })
    const rows = (await owner.query('select token_hash, ip_address from dpg_app.admin_sessions order by id desc limit 1')).rows
    expect(rows[0].token_hash).not.toBe(tokenValue); expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect((await call('GET', '/me', undefined, { token: tokenValue })).json.data.role).toBe('admin')
    expect((await call('POST', '/logout', {}, { token: tokenValue })).status).toBe(200)
    expect((await call('GET', '/me', undefined, { token: tokenValue })).status).toBe(401)
  })

  it('does not reveal accounts, blocks inactive users, and rate-limits persistently', async () => {
    const unknown = await loginAs('nobody@example.test', 'x', '10.8.8.1'); const wrong = await loginAs('admin@example.test', 'nope', '10.8.8.2')
    expect(unknown.status).toBe(401); expect(unknown.json.error.code).toBe('INVALID_CREDENTIALS'); expect(wrong.json.error.code).toBe('INVALID_CREDENTIALS')
    expect((await loginAs('off@example.test', 'off-pass-1', '10.8.8.3')).json.error.code).toBe('INVALID_CREDENTIALS')
    for (let i = 0; i < 4; i += 1) await loginAs('manager@example.test', 'bad', `10.7.7.${i}`)
    // 5th failure recorded; 6th attempt is locked even with the right password (key is the account, not the IP)
    await loginAs('manager@example.test', 'bad', '10.7.7.9')
    const locked = await loginAs('manager@example.test', 'manager-pass-1', '10.7.7.10')
    expect(locked.status).toBe(429); expect(locked.json.error.code).toBe('RATE_LIMITED')
    await owner.query("delete from dpg_app.admin_api_login_attempts")
  })

  it('compares against a real cost-12 hash when the user is unknown', async () => {
    expect(DUMMY_HASH).toMatch(/^\$2[aby]\$12\$/)
    expect(await bcrypt.compare('anything', DUMMY_HASH)).toBe(false)
  })

  it('rejects expired sessions and sessions of deactivated users', async () => {
    const t = await token('sale'); await owner.query("update dpg_app.admin_sessions set expires_at = now() - interval '1 minute'")
    expect((await call('GET', '/me', undefined, { token: t })).status).toBe(401)
    const t2 = await token('manager'); await owner.query("update dpg_app.admin_users set is_active=false where email='manager@example.test'")
    expect((await call('GET', '/me', undefined, { token: t2 })).status).toBe(401)
    await owner.query("update dpg_app.admin_users set is_active=true where email='manager@example.test'")
  })

  it('enforces RBAC on every operation server-side', async () => {
    const admin = await token('admin'), manager = await token('manager'), sale = await token('sale')
    expect((await call('GET', '/products', undefined)).status).toBe(401)
    for (const t of [admin, manager, sale]) expect((await call('GET', '/products?limit=5', undefined, { token: t })).status).toBe(200)
    for (const t of [manager, sale]) {
      expect((await call('PATCH', '/products/1', { input: { name: 'Hacked' } }, { token: t })).json.error.code).toBe('FORBIDDEN')
    }
    expect((await call('PATCH', '/products/1', { input: { name: 'Edited by admin' } }, { token: admin })).status).toBe(200)
    for (const role of ['admin', 'sale_manager', 'sale'] as AdminRole[]) expect(can(role, 'products:read')).toBe(true)
  })

  it('lists with pagination and search, escaping LIKE wildcards and ignoring SQL injection', async () => {
    const t = await token('admin')
    const page = await call('GET', '/products?limit=10&page=2', undefined, { token: t })
    expect(page.json.data).toMatchObject({ total: 30, page: 2, limit: 10 }); expect(page.json.data.items).toHaveLength(10)
    const q = await call('GET', '/products?q=' + encodeURIComponent('product 2'), undefined, { token: t }); expect(q.json.data.total).toBeGreaterThan(0)
    const wildcard = await call('GET', '/products?q=' + encodeURIComponent('%'), undefined, { token: t }); expect(wildcard.json.data.total).toBe(0)
    const inj = await call('GET', '/products?q=' + encodeURIComponent("x'; drop table dpg_app.products;--"), undefined, { token: t }); expect(inj.status).toBe(200)
    expect(Number((await owner.query('select count(*) from dpg_app.products')).rows[0].count)).toBe(30)
    expect((await call('GET', '/products?limit=500', undefined, { token: t })).status).toBe(400)
  })

  it('edits products atomically with versioning, audit and validation', async () => {
    const t = await token('admin')
    const before = await call('GET', '/products/2', undefined, { token: t }); const version = before.json.data.version
    const ok = await call('PATCH', '/products/2', { expected_version: version, input: { name: 'Renamed 2', is_featured: true, seo_title: 'Tiêu đề' } }, { token: t })
    expect(ok.status).toBe(200); expect(ok.json.data).toMatchObject({ name: 'Renamed 2', is_featured: true, version: version + 1 })
    expect((await call('PATCH', '/products/2', { expected_version: version, input: { name: 'Stale' } }, { token: t })).json.error.code).toBe('VERSION_CONFLICT')
    const audit = (await owner.query("select action, entity_id, changed_fields, old_value, new_value, user_id from dpg_app.audit_logs where entity_id=2 order by id desc limit 1")).rows[0]
    expect(audit).toMatchObject({ action: 'product.update', entity_id: 2 }); expect(audit.changed_fields).toEqual(['name', 'is_featured', 'seo_title']); expect(audit.old_value.name).toBe('Product 2')
    const invalid = [{ input: {} }, { input: { sku: 'X' } }, { input: { price: 1 } }, { input: { name: '' } }, { input: { publication_status: 'archived' } }, { input: { image_main_url: 'http://media.example.test/a.jpg' } }, { input: { image_main_url: 'https://evil.example/a.jpg' } }, { extra: 1, input: { name: 'x' } }]
    for (const body of invalid) expect((await call('PATCH', '/products/2', body, { token: t })).json.error.code).toBe('VALIDATION_FAILED')
    expect((await call('PATCH', '/products/2', { input: { image_main_url: 'https://media.example.test/a/b.jpg' } }, { token: t })).status).toBe(200)
    expect((await call('PATCH', '/products/99999', { input: { name: 'x' } }, { token: t })).json.error.code).toBe('NOT_FOUND')
    expect((await call('PATCH', '/products/abc', { input: { name: 'x' } }, { token: t })).json.error.code).toBe('NOT_FOUND')
    // Price must be untouched by any pilot edit.
    expect(Number((await owner.query('select price from dpg_app.products where id=2')).rows[0].price)).toBe(2000)
  })

  it('rolls the whole edit back when the audit write fails', async () => {
    const t = await token('admin'); const v = (await call('GET', '/products/3', undefined, { token: t })).json.data.version
    await owner.query('revoke insert on dpg_app.audit_logs from dpg_admin_api_test')
    try { expect((await call('PATCH', '/products/3', { input: { name: 'Should roll back' } }, { token: t })).status).toBe(500) }
    finally { await owner.query('grant insert on dpg_app.audit_logs to dpg_admin_api_test') }
    const row = (await owner.query('select name, version from dpg_app.products where id=3')).rows[0]
    expect(row).toMatchObject({ name: 'Product 3', version: v })
  })

  it('cannot touch anything outside its grants (database-enforced least privilege)', async () => {
    for (const statement of [
      'update dpg_app.products set price = 1', 'update dpg_app.products set sku = \'x\'', 'update dpg_app.products set list_price = 1',
      'delete from dpg_app.products', 'insert into dpg_app.products(sku,name,slug,category_id) values (\'a\',\'b\',\'c\',1)',
      'select * from dpg_app.orders', 'update dpg_app.admin_users set role = \'admin\'', 'update dpg_app.admin_users set password_hash = \'x\'',
      'delete from dpg_app.admin_users', 'update dpg_app.categories set name = \'x\'', 'update dpg_app.audit_logs set action = \'x\'', 'delete from dpg_app.audit_logs',
      'select list_price from dpg_app.products',
    ]) await expect(apiPool.query(statement), statement).rejects.toThrow(/permission denied/)
  })

  describe('generic Admin resources', () => {
    const MEDIA = 'https://media.example.test'
    const code = (r: { json: any }) => r.json.error?.code

    it('serves role-filtered form metadata without internals', async () => {
      expect((await call('GET', '/schema')).status).toBe(401)
      const admin = await token('admin'), manager = await token('manager'), sale = await token('sale')
      const a = await call('GET', '/schema', undefined, { token: admin })
      const resources = a.json.data.resources as { key: string }[]
      expect(resources.map((r) => r.key)).toEqual(expect.arrayContaining(['blog-posts', 'blog-tags', 'banners', 'partners', 'projects']))
      expect(a.json.data.resources.find((r: { key: string }) => r.key === 'blog-posts')).toMatchObject({ canCreate: true, canUpdate: true, canDelete: true, versioned: true })
      expect(a.json.data.resources.find((r: { key: string }) => r.key === 'blog-tags')).toMatchObject({ canCreate: true, canUpdate: false, canDelete: true })
      expect(a.json.data.resources.find((r: { key: string }) => r.key === 'blog-categories')).toMatchObject({ canCreate: false, canUpdate: false, canDelete: false })
      expect(JSON.stringify(a.json.data)).not.toMatch(/blog:write|dpg_app|select |insert /)
      for (const who of [manager, sale]) expect((await call('GET', '/schema', undefined, { token: who })).json.data.resources).toEqual([])
    })

    it('enforces RBAC on every generic operation', async () => {
      const manager = await token('manager'), sale = await token('sale'), admin = await token('admin')
      for (const route of ['/r/banners', '/r/blog-posts', '/r/blog-tags', '/r/partners/options']) expect((await call('GET', route)).status).toBe(401)
      for (const who of [manager, sale]) {
        expect(code(await call('GET', '/r/banners', undefined, { token: who }))).toBe('FORBIDDEN')
        expect(code(await call('POST', '/r/banners', { input: { image_url: `${MEDIA}/a.webp` } }, { token: who }))).toBe('FORBIDDEN')
        expect(code(await call('PATCH', '/r/blog-posts/1', { expected_version: 1, input: { title: 'x' } }, { token: who }))).toBe('FORBIDDEN')
        expect(code(await call('DELETE', '/r/projects/1', {}, { token: who }))).toBe('FORBIDDEN')
      }
      expect(code(await call('GET', '/r/unknown-thing', undefined, { token: admin }))).toBe('NOT_FOUND')
      expect(code(await call('POST', '/r/blog-categories', { input: { name: 'x' } }, { token: admin }))).toBe('NOT_FOUND') // read-only resource
      expect(code(await call('DELETE', '/r/blog-categories/1', {}, { token: admin }))).toBe('NOT_FOUND')
    })

    it('creates tags, rejects duplicates and deactivates instead of deleting', async () => {
      const t = await token('admin')
      const created = await call('POST', '/r/blog-tags', { input: { name: 'Phòng tắm', slug: 'phong-tam' } }, { token: t })
      expect(created.status).toBe(201); expect(created.json.data).toMatchObject({ name: 'Phòng tắm', slug: 'phong-tam', post_count: 0, is_active: true })
      expect(code(await call('POST', '/r/blog-tags', { input: { name: 'Khác', slug: 'phong-tam' } }, { token: t }))).toBe('DUPLICATE')
      expect(code(await call('PATCH', `/r/blog-tags/${created.json.data.id}`, { input: { name: 'Đổi' } }, { token: t }))).toBe('NOT_FOUND')
      const removed = await call('DELETE', `/r/blog-tags/${created.json.data.id}`, {}, { token: t })
      expect(removed.json.data).toMatchObject({ ok: true, result: 'deactivated' })
      expect((await owner.query('select is_active from dpg_app.blog_tags where id=$1', [created.json.data.id])).rows[0].is_active).toBe(false)
      const options = await call('GET', '/r/blog-categories/options', undefined, { token: t })
      expect(options.json.data.items).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Tin tức' })]))
    })

    it('runs the blog post lifecycle: tags, versions, publish dates, publishing rules, audit', async () => {
      const t = await token('admin')
      const mk = async (name: string, slug: string) => (await call('POST', '/r/blog-tags', { input: { name, slug } }, { token: t })).json.data.id as number
      const tagA = await mk('Tag A', 'tag-a'), tagB = await mk('Tag B', 'tag-b')
      const base = { title: 'Bài đầu', slug: 'bai-dau', category_id: 1, content: '<p>Xin chào</p>', thumbnail_url: `${MEDIA}/blog/a.webp`, tag_ids: [tagA, tagB] }
      const created = await call('POST', '/r/blog-posts', { input: { ...base, status: 'published' } }, { token: t })
      expect(created.status).toBe(201)
      const post = created.json.data
      expect(post).toMatchObject({ title: 'Bài đầu', status: 'published', version: 1, tag_ids: [tagA, tagB] }); expect(post.published_at).toBeTruthy()
      const counts = async () => Object.fromEntries((await owner.query('select id, post_count from dpg_app.blog_tags where id = any($1)', [[tagA, tagB]])).rows.map((r) => [r.id, r.post_count]))
      expect(await counts()).toEqual({ [tagA]: 1, [tagB]: 1 })

      const list = await call('GET', '/r/blog-posts?status=published&q=bai-dau', undefined, { token: t })
      expect(list.json.data).toMatchObject({ total: 1, page: 1 }); expect(list.json.data.items[0]).toMatchObject({ id: post.id, title: 'Bài đầu' })
      expect((await call('GET', '/r/blog-posts?q=' + encodeURIComponent('%'), undefined, { token: t })).json.data.total).toBe(0)
      expect(code(await call('GET', '/r/blog-posts?status=bogus', undefined, { token: t }))).toBe('VALIDATION_FAILED')
      expect(code(await call('GET', '/r/blog-posts?sort=id', undefined, { token: t }))).toBe('VALIDATION_FAILED')

      const invalid: [string, unknown][] = [
        ['missing title', { ...base, title: undefined, slug: 'a1' }], ['unknown key', { ...base, slug: 'a2', hacked: 1 }],
        ['bad status', { ...base, slug: 'a3', status: 'archived' }], ['script', { ...base, slug: 'a4', content: '<p>x</p><script>alert(1)</script>' }],
        ['js link', { ...base, slug: 'a5', content: '<a href="javascript:alert(1)">x</a>' }], ['foreign media', { ...base, slug: 'a6', thumbnail_url: 'https://evil.example/a.webp' }],
        ['readonly field', { ...base, slug: 'a7', view_count: 99 }], ['version via input', { ...base, slug: 'a8', version: 9 }],
        ['too many tags', { ...base, slug: 'a9', tag_ids: Array.from({ length: 51 }, (_, i) => i + 1) }],
      ]
      for (const [label, input] of invalid) expect(code(await call('POST', '/r/blog-posts', { input }, { token: t })), label).toBe('VALIDATION_FAILED')
      expect(code(await call('POST', '/r/blog-posts', { input: { ...base, slug: 'bai-dau' } }, { token: t }))).toBe('DUPLICATE')
      expect(code(await call('POST', '/r/blog-posts', { input: { ...base, slug: 'cat-sai', category_id: 999 } }, { token: t }))).toBe('REFERENCE_CONFLICT')
      expect(code(await call('POST', '/r/blog-posts', { input: { ...base, slug: 'tag-sai', tag_ids: [tagA, 9999] } }, { token: t }))).toBe('REFERENCE_CONFLICT')
      expect(Number((await owner.query("select count(*) from dpg_app.blog_posts where slug in ('cat-sai','tag-sai')")).rows[0].count)).toBe(0) // rolled back

      expect(code(await call('PATCH', `/r/blog-posts/${post.id}`, { input: { title: 'No version' } }, { token: t }))).toBe('VALIDATION_FAILED')
      const edited = await call('PATCH', `/r/blog-posts/${post.id}`, { expected_version: 1, input: { title: 'Bài đã sửa', tag_ids: [tagB] } }, { token: t })
      expect(edited.status).toBe(200); expect(edited.json.data).toMatchObject({ title: 'Bài đã sửa', version: 2, tag_ids: [tagB] })
      expect(await counts()).toEqual({ [tagA]: 0, [tagB]: 1 })
      expect(code(await call('PATCH', `/r/blog-posts/${post.id}`, { expected_version: 1, input: { title: 'Stale' } }, { token: t }))).toBe('VERSION_CONFLICT')
      expect(code(await call('PATCH', '/r/blog-posts/999999', { expected_version: 1, input: { title: 'x' } }, { token: t }))).toBe('NOT_FOUND')

      const draft = await call('PATCH', `/r/blog-posts/${post.id}`, { expected_version: 2, input: { status: 'draft' } }, { token: t })
      expect(draft.json.data).toMatchObject({ status: 'draft', published_at: null, version: 3 })
      expect((await owner.query('select first_published_at from dpg_app.blog_posts where id=$1', [post.id])).rows[0].first_published_at).not.toBeNull()
      const again = await call('PATCH', `/r/blog-posts/${post.id}`, { expected_version: 3, input: { status: 'published' } }, { token: t })
      expect(again.json.data.published_at).toBeTruthy()
      const publishedAt = again.json.data.published_at
      const keep = await call('PATCH', `/r/blog-posts/${post.id}`, { expected_version: 4, input: { is_featured: true, seo_title: 'SEO' } }, { token: t })
      expect(keep.json.data).toMatchObject({ is_featured: true, seo_title: 'SEO', version: 5 }); expect(new Date(keep.json.data.published_at).getTime()).toBe(new Date(publishedAt).getTime())

      // Publishing-Agent posts: content/media stay behind the Publishing API, metadata edits and unpublish are allowed.
      await owner.query('update dpg_app.blog_posts set publishing_identity_id = gen_random_uuid() where id=$1', [post.id])
      expect(code(await call('PATCH', `/r/blog-posts/${post.id}`, { expected_version: 5, input: { content: '<p>Đổi</p>' } }, { token: t }))).toBe('PUBLISHING_MANAGED')
      const meta = await call('PATCH', `/r/blog-posts/${post.id}`, { expected_version: 5, input: { seo_title: 'SEO 2' } }, { token: t })
      expect(meta.status).toBe(200)
      const unpublished = await call('DELETE', `/r/blog-posts/${post.id}`, { expected_version: 6 }, { token: t })
      expect(unpublished.json.data).toMatchObject({ ok: true, result: 'unpublished' })
      expect((await owner.query('select status, published_at, version from dpg_app.blog_posts where id=$1', [post.id])).rows[0]).toMatchObject({ status: 'draft', published_at: null, version: 7 })
      await owner.query('update dpg_app.blog_posts set publishing_identity_id = null where id=$1', [post.id])
      expect(code(await call('DELETE', `/r/blog-posts/${post.id}`, { expected_version: 6 }, { token: t }))).toBe('VERSION_CONFLICT')
      expect(code(await call('DELETE', `/r/blog-posts/${post.id}`, {}, { token: t }))).toBe('VALIDATION_FAILED')
      expect((await call('DELETE', `/r/blog-posts/${post.id}`, { expected_version: 7 }, { token: t })).json.data).toMatchObject({ result: 'deleted' })
      expect(Number((await owner.query('select count(*) from dpg_app.blog_posts where id=$1', [post.id])).rows[0].count)).toBe(0)
      expect(await counts()).toEqual({ [tagA]: 0, [tagB]: 0 })
      const actions = (await owner.query("select action from dpg_app.audit_logs where entity_type='blog-posts' and entity_id=$1 order by id", [post.id])).rows.map((r) => r.action)
      expect(actions).toEqual(['blog-posts.create', 'blog-posts.update', 'blog-posts.update', 'blog-posts.update', 'blog-posts.update', 'blog-posts.update', 'blog-posts.unpublish', 'blog-posts.delete'])
    })

    it('manages banners with link and media validation', async () => {
      const t = await token('admin'); const image = `${MEDIA}/banners/b.webp`
      for (const link of ['javascript:alert(1)', '//evil.example/x', 'ftp://x.example', 'data:text/html,x']) {
        expect(code(await call('POST', '/r/banners', { input: { image_url: image, link_url: link } }, { token: t })), link).toBe('VALIDATION_FAILED')
      }
      expect(code(await call('POST', '/r/banners', { input: { image_url: 'https://evil.example/b.webp' } }, { token: t }))).toBe('VALIDATION_FAILED')
      expect(code(await call('POST', '/r/banners', { input: { title: 'No image' } }, { token: t }))).toBe('VALIDATION_FAILED')
      const created = await call('POST', '/r/banners', { input: { image_url: image, link_url: '/thiet-bi-ve-sinh', title: 'Khuyến mãi' } }, { token: t })
      expect(created.status).toBe(201); expect(created.json.data).toMatchObject({ link_url: '/thiet-bi-ve-sinh', is_active: true, sort_order: 0 })
      const edited = await call('PATCH', `/r/banners/${created.json.data.id}`, { input: { sort_order: 5, link_url: '', is_active: false } }, { token: t })
      expect(edited.json.data).toMatchObject({ sort_order: 5, link_url: null, is_active: false })
      expect((await call('DELETE', `/r/banners/${created.json.data.id}`, {}, { token: t })).json.data.result).toBe('deleted')
      expect(code(await call('GET', `/r/banners/${created.json.data.id}`, undefined, { token: t }))).toBe('NOT_FOUND')
    })

    it('generates partner/project slugs once and stores tag arrays', async () => {
      const t = await token('admin')
      const partner = await call('POST', '/r/partners', { input: { name: 'Công ty ABC' } }, { token: t })
      expect(partner.json.data.slug).toMatch(/^cong-ty-abc-\d{10,}$/); expect(partner.json.data).toMatchObject({ tier: 'Vàng', is_active: true })
      expect(code(await call('POST', '/r/partners', { input: { name: 'X', slug: 'x' } }, { token: t }))).toBe('VALIDATION_FAILED')
      const renamed = await call('PATCH', `/r/partners/${partner.json.data.id}`, { input: { name: 'Công ty ABC mới' } }, { token: t })
      expect(renamed.json.data).toMatchObject({ name: 'Công ty ABC mới', slug: partner.json.data.slug })
      const project = await call('POST', '/r/projects', { input: { title: 'Biệt thự Đà Lạt', tags: ['biet-thu', 'da-lat'], is_featured: true } }, { token: t })
      expect(project.json.data).toMatchObject({ tags: ['biet-thu', 'da-lat'], is_featured: true }); expect(project.json.data.slug).toMatch(/^biet-thu-da-lat-\d{10,}$/)
      expect((await call('PATCH', `/r/projects/${project.json.data.id}`, { input: { tags: [] } }, { token: t })).json.data.tags).toEqual([])
      expect(code(await call('PATCH', `/r/projects/${project.json.data.id}`, { input: { tags: [''] } }, { token: t }))).toBe('VALIDATION_FAILED')
    })

    it('database blocks anything outside the generated grants', async () => {
      for (const statement of [
        'update dpg_app.blog_posts set view_count = 9', 'update dpg_app.blog_posts set created_at = now()', 'select created_at from dpg_app.blog_posts',
        'delete from dpg_app.blog_categories', "insert into dpg_app.blog_categories(name,slug) values ('x','y')", "update dpg_app.blog_categories set name='x'",
        "update dpg_app.blog_tags set name='x'", 'delete from dpg_app.blog_tags', "insert into dpg_app.blog_tags(name,slug,post_count) values ('x','z',5)",
        "update dpg_app.partners set slug='x'", 'update dpg_app.banners set brand_id = 1', 'update dpg_app.projects set created_at = now()',
      ]) await expect(apiPool.query(statement), statement).rejects.toThrow(/permission denied/)
    })
  })

  it('fails closed without configuration', async () => {
    const response = await handleRequest(new Request(BASE + '/me'), { ...deps(), hmacSecret: '' })
    expect(response.status).toBe(401)
  })
})
