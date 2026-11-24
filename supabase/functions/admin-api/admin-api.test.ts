// @vitest-environment node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { signEnvelope, verifyEnvelope, randomNonce, routeOf } from './envelope.mjs'
import { handleRequest, DUMMY_HASH, type Db } from './handlers.ts'
import { can, type AdminRole } from './permissions.ts'
import { setExternalColumns } from './resources.ts'

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
    expect(await verifyEnvelope(SECRET, { ...base, headers: headersOf(h), now: Date.now() + 62_000 })).toMatchObject({ ok: false, code: 'EXPIRED_REQUEST' })
    expect(await verifyEnvelope(SECRET, { ...base, headers: headersOf(h), now: Date.now() - 62_000 })).toMatchObject({ ok: false, code: 'EXPIRED_REQUEST' })
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
    await owner.query(await readFile(path.join(root, 'supabase/functions/admin-api/test-fixtures/base.sql'), 'utf8'))
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
    // #446: canonical price column grants live in a separate reviewed migration (target guard needs the TEST-only schema).
    await owner.query((await readFile(path.join(root, 'supabase/m3-test/007_hita_canonical_price_admin_grants.sql'), 'utf8')).replace(/-- guard:begin[\s\S]*?-- guard:end\n/, ''))
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
    hashPassword: (plain: string) => bcrypt.hash(plain, 4),
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
    expect((await call('GET', '/r/products', undefined, { nonce })).status).toBe(401) // unauthenticated but nonce consumed
    expect((await call('GET', '/r/products', undefined, { nonce })).json.error.code).toBe('REPLAYED_REQUEST')
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
    expect((await call('GET', '/r/products', undefined)).status).toBe(401)
    for (const t of [admin, manager, sale]) expect((await call('GET', '/r/products?limit=5', undefined, { token: t })).status).toBe(200)
    for (const t of [manager, sale]) {
      expect((await call('PATCH', '/r/products/1', { expected_version: 1, input: { name: 'Hacked' } }, { token: t })).json.error.code).toBe('FORBIDDEN')
    }
    const v1 = (await call('GET', '/r/products/1', undefined, { token: admin })).json.data.version
    expect((await call('PATCH', '/r/products/1', { expected_version: v1, input: { name: 'Edited by admin' } }, { token: admin })).status).toBe(200)
    for (const role of ['admin', 'sale_manager', 'sale'] as AdminRole[]) expect(can(role, 'products:read')).toBe(true)
  })

  it('lists with pagination and search, escaping LIKE wildcards and ignoring SQL injection', async () => {
    const t = await token('admin')
    const page = await call('GET', '/r/products?limit=10&page=2', undefined, { token: t })
    expect(page.json.data).toMatchObject({ total: 30, page: 2, limit: 10 }); expect(page.json.data.items).toHaveLength(10)
    const q = await call('GET', '/r/products?q=' + encodeURIComponent('product 2'), undefined, { token: t }); expect(q.json.data.total).toBeGreaterThan(0)
    const wildcard = await call('GET', '/r/products?q=' + encodeURIComponent('%'), undefined, { token: t }); expect(wildcard.json.data.total).toBe(0)
    const inj = await call('GET', '/r/products?q=' + encodeURIComponent("x'; drop table dpg_app.products;--"), undefined, { token: t }); expect(inj.status).toBe(200)
    expect(Number((await owner.query('select count(*) from dpg_app.products')).rows[0].count)).toBe(30)
    expect((await call('GET', '/r/products?limit=500', undefined, { token: t })).status).toBe(400)
  })

  it('edits products atomically with versioning, audit and validation', async () => {
    const t = await token('admin')
    const before = await call('GET', '/r/products/2', undefined, { token: t }); const version = before.json.data.version
    const ok = await call('PATCH', '/r/products/2', { expected_version: version, input: { name: 'Renamed 2', is_featured: true, seo_title: 'Tiêu đề' } }, { token: t })
    expect(ok.status).toBe(200); expect(ok.json.data).toMatchObject({ name: 'Renamed 2', is_featured: true, version: version + 1 })
    expect((await call('PATCH', '/r/products/2', { expected_version: version, input: { name: 'Stale' } }, { token: t })).json.error.code).toBe('VERSION_CONFLICT')
    const audit = (await owner.query("select action, entity_id, old_value, new_value, user_id from dpg_app.audit_logs where entity_id=2 order by id desc limit 1")).rows[0]
    expect(audit).toMatchObject({ action: 'products.update', entity_id: 2 }); expect(audit.new_value._meta.changed_fields).toEqual(['name', 'is_featured', 'seo_title']); expect(audit.new_value._meta.request_id).toMatch(/^[0-9a-f-]{36}$/); expect(audit.old_value.name).toBe('Product 2')
    const invalid = [{ input: {} }, { input: { sku: 'X' } }, { input: { slug: 'x' } }, { input: { name: '' } }, { input: { publication_status: 'archived' } }, { input: { image_main_url: 'http://media.example.test/a.jpg' } }, { input: { image_main_url: 'https://evil.example/a.jpg' } }, { extra: 1, input: { name: 'x' } }]
    for (const body of invalid) expect((await call('PATCH', '/r/products/2', { expected_version: version + 1, ...(body as object) }, { token: t })).json.error.code, JSON.stringify(body)).toBe('VALIDATION_FAILED')
    expect((await call('PATCH', '/r/products/2', { expected_version: version + 1, input: { image_main_url: 'https://media.example.test/a/b.jpg' } }, { token: t })).status).toBe(200)
    expect((await call('PATCH', '/r/products/99999', { expected_version: 1, input: { name: 'x' } }, { token: t })).json.error.code).toBe('NOT_FOUND')
    expect((await call('PATCH', '/r/products/abc', { expected_version: 1, input: { name: 'x' } }, { token: t })).json.error.code).toBe('NOT_FOUND')
    // None of these edits touches the price.
    expect(Number((await owner.query('select price from dpg_app.products where id=2')).rows[0].price)).toBe(2000)
  })

  it('rolls the whole edit back when the audit write fails', async () => {
    const t = await token('admin'); const v = (await call('GET', '/r/products/3', undefined, { token: t })).json.data.version
    await owner.query('revoke insert on dpg_app.audit_logs from dpg_admin_api_test')
    try { expect((await call('PATCH', '/r/products/3', { expected_version: v, input: { name: 'Should roll back' } }, { token: t })).status).toBe(500) }
    finally { await owner.query('grant insert on dpg_app.audit_logs to dpg_admin_api_test') }
    const row = (await owner.query('select name, version from dpg_app.products where id=3')).rows[0]
    expect(row).toMatchObject({ name: 'Product 3', version: v })
  })

  it('cannot touch anything outside its grants (database-enforced least privilege)', async () => {
    for (const statement of [
      'update dpg_app.products set sku = \'x\'', 'update dpg_app.products set slug = \'x\'', 'update dpg_app.products set created_at = now()', 'update dpg_app.products set id = 999',
      'select * from dpg_app.orders', 'update dpg_app.admin_users set avatar_url = \'x\'', 'update dpg_app.admin_users set supabase_auth_user_id = null',
      'delete from dpg_app.admin_users', 'update dpg_app.categories set name = \'x\'', 'update dpg_app.audit_logs set action = \'x\'', 'delete from dpg_app.audit_logs',
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
      const keysOf = async (who: string) => (await call('GET', '/schema', undefined, { token: who })).json.data.resources.map((r: { key: string }) => r.key).sort()
      const childKeys = ['product-documents', 'product-images', 'product-relationships', 'product-spec-values', 'product-taxon-assignments']
      expect(await keysOf(manager)).toEqual(['customers', ...childKeys, 'products'].sort())
      expect(await keysOf(sale)).toEqual(['customers', ...childKeys, 'products'].sort())
      expect(a.json.data.resources.find((r: { key: string }) => r.key === 'products').children.map((c: { key: string }) => c.key).sort()).toEqual(childKeys.filter((k) => k !== 'product-images')) // the gallery has its own panel
      expect(a.json.data.resources.find((r: { key: string }) => r.key === 'product-documents')).toMatchObject({ inNav: false, canCreate: true })
      expect((await call('GET', '/schema', undefined, { token: manager })).json.data.resources.find((r: { key: string }) => r.key === 'customers')).toMatchObject({ canCreate: true, canUpdate: true })
      expect((await call('GET', '/schema', undefined, { token: sale })).json.data.resources.find((r: { key: string }) => r.key === 'products')).toMatchObject({ canCreate: false, canUpdate: false, canDelete: false, inNav: true })
      expect(a.json.data.resources.find((r: { key: string }) => r.key === 'product-images').inNav).toBe(false)
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

    it('serves Dev-managed master data as read-only options only, for every role (#309 scope decision)', async () => {
      const admin = await token('admin'), manager = await token('manager'), sale = await token('sale')
      const MASTER = ['categories', 'subcategories', 'brands', 'catalog-taxons', 'product-types', 'product-sub-types', 'spec-definitions', 'spec-options', 'origins', 'colors', 'materials']
      for (const who of [admin, manager, sale]) {
        for (const key of MASTER) {
          for (const [method, route, body] of [['GET', `/r/${key}`], ['GET', `/r/${key}/1`], ['POST', `/r/${key}`, { input: { name: 'x' } }], ['PATCH', `/r/${key}/1`, { input: { name: 'x' } }], ['DELETE', `/r/${key}/1`, {}]] as [string, string, unknown?][]) {
            expect(code(await call(method, route, body, { token: who })), `${method} ${route}`).toBe('DEV_MANAGED')
          }
        }
      }
      expect((await call('GET', '/r/brands/options', undefined, { token: admin })).status).toBe(200)
      expect((await call('GET', '/r/categories/options', undefined, { token: manager })).status).toBe(200)
      expect((await call('GET', '/r/colors/options', undefined, { token: sale })).status).toBe(200)
      expect((await call('GET', '/r/categories/options', undefined, { token: sale })).status).toBe(200) // labels for product rows (products:read)
      expect(code(await call('GET', '/r/blog-categories/options', undefined, { token: sale }))).toBe('FORBIDDEN') // non-lookup resources keep their own permission
      expect(code(await call('GET', '/r/brands/options', undefined, { token: 'none' }))).toBe('UNAUTHENTICATED')
      // The database enforces the same boundary even if a handler were wrong: no write privilege remains on the master tables.
      for (const statement of ["update dpg_app.categories set name='x'", "update dpg_app.brands set name='x'", "insert into dpg_app.brands(name,slug) values ('x','y')", 'delete from dpg_app.brands',
        "insert into dpg_app.catalog_taxons(name,slug,canonical_path) values ('x','y','/y')", "update dpg_app.product_types set name='x'", "insert into dpg_app.spec_definitions(key,label) values ('k','l')", "insert into dpg_app.spec_options(spec_definition_id,value,slug) values (1,'v','s')",
        "update dpg_app.subcategories set name='x'", "update dpg_app.product_sub_types set name='x'"]) {
        await expect(apiPool.query(statement), statement).rejects.toThrow(/permission denied/)
      }
    })

    it('006 revoke-only migration removes the legacy master-data writes on an already-granted TEST database and its rollback restores them', async () => {
      const MASTER = ['categories', 'subcategories', 'brands', 'catalog_taxons', 'product_types', 'product_sub_types', 'spec_definitions', 'spec_options']
      const strip = (sql: string) => sql.replace(/-- guard:begin[\s\S]*?-- guard:end\n/, '')
      const forward = strip(await readFile(path.join(root, 'supabase/m3-test/006_m3_test_admin_scope_revoke.sql'), 'utf8'))
      const rollback = await readFile(path.join(root, 'supabase/m3-test/006_m3_test_admin_scope_revoke_rollback.sql'), 'utf8')
      const writes = async (table: string, command: 'INSERT' | 'UPDATE') => (await owner.query('select has_any_column_privilege($1, $2, $3) as ok', [apiRole, `dpg_app.${table}`, command])).rows[0].ok as boolean
      const policies = async () => Number((await owner.query("select count(*) as n from pg_policies where schemaname='dpg_app' and tablename = any($1) and policyname in ('m3_admin_api_insert','m3_admin_api_update','m3_admin_api_delete')", [MASTER])).rows[0].n)
      await owner.query(rollback) // state as before the Owner scope decision
      expect(await writes('brands', 'INSERT')).toBe(true); expect(await writes('categories', 'UPDATE')).toBe(true); expect(await policies()).toBeGreaterThan(0)
      await owner.query(forward)
      for (const table of MASTER) { expect(await writes(table, 'INSERT'), `${table} insert`).toBe(false); expect(await writes(table, 'UPDATE'), `${table} update`).toBe(false) }
      expect(await policies()).toBe(0)
      expect((await owner.query('select has_table_privilege($1, $2, $3) as ok', [apiRole, 'dpg_app.brands', 'DELETE'])).rows[0].ok).toBe(false)
      expect((await owner.query('select has_any_column_privilege($1, $2, $3) as ok', [apiRole, 'dpg_app.brands', 'SELECT'])).rows[0].ok).toBe(true) // lookups keep working
      expect(await writes('products', 'UPDATE')).toBe(true); expect(await writes('product_spec_values', 'INSERT')).toBe(true); expect(await writes('product_taxon_assignments', 'INSERT')).toBe(true) // per-product records stay editable
      await owner.query(forward) // idempotent
      expect(await writes('brands', 'INSERT')).toBe(false)
    })

    it('lets sale managers write customers, sale read only, and rejects duplicate phones', async () => {
      const manager = await token('manager'), sale = await token('sale')
      const created = await call('POST', '/r/customers', { input: { full_name: 'Nguyễn Văn A', phone: '0901234567', email: 'a@example.test' } }, { token: manager })
      expect(created.status).toBe(201); expect(created.json.data).toMatchObject({ source: 'MANUAL', full_name: 'Nguyễn Văn A' }); expect(created.json.data.last_interacted_at).toBeTruthy()
      expect(code(await call('POST', '/r/customers', { input: { full_name: 'Trùng', phone: '0901234567' } }, { token: manager }))).toBe('DUPLICATE')
      expect((await call('PATCH', `/r/customers/${created.json.data.id}`, { input: { notes: 'VIP', source: 'FACEBOOK' } }, { token: manager })).json.data).toMatchObject({ notes: 'VIP', source: 'FACEBOOK' })
      expect((await call('GET', '/r/customers?q=0901', undefined, { token: sale })).json.data.total).toBe(1)
      expect(code(await call('POST', '/r/customers', { input: { full_name: 'X', phone: '0911111111' } }, { token: sale }))).toBe('FORBIDDEN')
      expect(code(await call('PATCH', `/r/customers/${created.json.data.id}`, { input: { notes: 'x' } }, { token: sale }))).toBe('FORBIDDEN')
      expect(code(await call('DELETE', `/r/customers/${created.json.data.id}`, {}, { token: manager }))).toBe('NOT_FOUND')
    })

    it('manages users: server-side bcrypt, no hash exposure, session revocation and last-admin protection', async () => {
      const admin = await token('admin'), manager = await token('manager'), sale = await token('sale')
      for (const who of [manager, sale]) { expect(code(await call('GET', '/r/users', undefined, { token: who }))).toBe('FORBIDDEN'); expect(code(await call('POST', '/r/users', { input: { email: 'x@example.test', name: 'X', password: 'password-123' } }, { token: who }))).toBe('FORBIDDEN') }
      const weak = await call('POST', '/r/users', { input: { email: 'weak@example.test', name: 'Weak', password: 'short' } }, { token: admin })
      expect(weak.json.error).toMatchObject({ code: 'VALIDATION_FAILED', fields: ['password'] }); expect(JSON.stringify(weak.json)).not.toContain('short')
      expect(code(await call('POST', '/r/users', { input: { email: 'noo@example.test', name: 'No password' } }, { token: admin }))).toBe('VALIDATION_FAILED')
      expect(code(await call('POST', '/r/users', { input: { email: 'bad-email', name: 'X', password: 'password-123' } }, { token: admin }))).toBe('VALIDATION_FAILED')
      expect(code(await call('POST', '/r/users', { input: { email: 'x@example.test', name: 'X', password: 'password-123', role: 'owner' } }, { token: admin }))).toBe('VALIDATION_FAILED')
      const created = await call('POST', '/r/users', { input: { email: 'New.User@Example.test', name: 'Người mới', role: 'sale_manager', password: 'password-123' } }, { token: admin })
      expect(created.status).toBe(201); expect(created.json.data).toMatchObject({ email: 'new.user@example.test', role: 'sale_manager', is_active: true })
      expect(JSON.stringify(created.json)).not.toMatch(/password|\$2[aby]\$/)
      const hash = (await owner.query('select password_hash from dpg_app.admin_users where id=$1', [created.json.data.id])).rows[0].password_hash
      expect(hash).toMatch(/^\$2[aby]\$/); expect(await bcrypt.compare('password-123', hash)).toBe(true)
      expect(code(await call('POST', '/r/users', { input: { email: 'new.user@example.test', name: 'Trùng', password: 'password-123' } }, { token: admin }))).toBe('DUPLICATE')
      expect((await loginAs('new.user@example.test', 'password-123', '10.4.4.1')).status).toBe(200)
      expect(JSON.stringify((await call('GET', `/r/users/${created.json.data.id}`, undefined, { token: admin })).json)).not.toMatch(/password/)
      expect((await call('GET', '/r/users?role=sale_manager&q=nguoi', undefined, { token: admin })).json.data.total).toBeGreaterThanOrEqual(0)

      // password change and deactivation revoke the account's sessions
      const victim = (await loginAs('new.user@example.test', 'password-123', '10.4.4.2')).json.data.token as string
      expect((await call('GET', '/me', undefined, { token: victim })).status).toBe(200)
      expect((await call('PATCH', `/r/users/${created.json.data.id}`, { input: { password: 'another-pass-456' } }, { token: admin })).status).toBe(200)
      expect((await call('GET', '/me', undefined, { token: victim })).status).toBe(401)
      expect((await loginAs('new.user@example.test', 'password-123', '10.4.4.3')).status).toBe(401)
      expect((await loginAs('new.user@example.test', 'another-pass-456', '10.4.4.4')).status).toBe(200)
      const second = (await loginAs('new.user@example.test', 'another-pass-456', '10.4.4.5')).json.data.token as string
      expect((await call('PATCH', `/r/users/${created.json.data.id}`, { input: { is_active: false } }, { token: admin })).json.data.is_active).toBe(false)
      expect((await call('GET', '/me', undefined, { token: second })).status).toBe(401)
      expect((await loginAs('new.user@example.test', 'another-pass-456', '10.4.4.6')).status).toBe(401)

      // the last active admin cannot be deactivated or demoted; with a second admin it can
      const adminId = (await owner.query("select id from dpg_app.admin_users where email='admin@example.test'")).rows[0].id as number
      expect(code(await call('PATCH', `/r/users/${adminId}`, { input: { is_active: false } }, { token: admin }))).toBe('LAST_ADMIN')
      expect(code(await call('PATCH', `/r/users/${adminId}`, { input: { role: 'sale' } }, { token: admin }))).toBe('LAST_ADMIN')
      const other = await call('POST', '/r/users', { input: { email: 'admin2@example.test', name: 'Admin 2', role: 'admin', password: 'password-123' } }, { token: admin })
      expect((await call('PATCH', `/r/users/${other.json.data.id}`, { input: { role: 'sale' } }, { token: admin })).status).toBe(200) // admin2 may be demoted: admin@ stays active
      expect((await call('PATCH', `/r/users/${adminId}`, { input: { name: 'Admin (đổi tên)' } }, { token: admin })).status).toBe(200)
      await owner.query("update dpg_app.admin_users set name='Admin' where id=$1", [adminId])
      // the API can never read or change hashes outside the password flow, nor delete accounts
      await expect(apiPool.query('delete from dpg_app.admin_users'), 'delete users').rejects.toThrow(/permission denied/)
      await expect(apiPool.query("update dpg_app.admin_users set avatar_url='x'"), 'avatar').rejects.toThrow(/permission denied/)
      const audit = (await owner.query("select new_value from dpg_app.audit_logs where entity_type='users' and entity_id=$1 order by id", [created.json.data.id])).rows
      expect(JSON.stringify(audit)).not.toMatch(/\$2[aby]\$|password-123|another-pass/)
      expect(audit[1].new_value._meta.changed_fields).toContain('password_hash')
    })

    describe('orders, quotes and dashboard', () => {
      const uid = async (email: string) => (await owner.query('select id from dpg_app.admin_users where email=$1', [email])).rows[0].id as number
      let saleId = 0, managerId = 0, orderA = 0, orderB = 0, quoteA = 0, quoteB = 0
      beforeAll(async () => {
        saleId = await uid('sale@example.test'); managerId = await uid('manager@example.test')
        const order = async (n: string, name: string, assigned: number | null, status = 'pending') => (await owner.query(
          `insert into dpg_app.orders(order_number, customer_name, customer_phone, status, assigned_to, internal_note) values ($1::text,$2::text,'0900000000',$3::text,$4::int,'secret') returning id`, [n, name, status, assigned])).rows[0].id as number
        orderA = await order('DPG-A', 'Khách A', saleId); orderB = await order('DPG-B', 'Khách B', null)
        for (const [o, p, price, qty] of [[orderA, 1, 1000, 2], [orderA, 2, 500, 1], [orderB, 3, 700, 1]]) await owner.query(`insert into dpg_app.order_items(order_id, product_id, product_name, product_sku, quantity, unit_price, total_price) values ($1::int,$2::int,'Sản phẩm '||$2::text,'SKU-'||$2::text,$3::int,$4::numeric,$4::numeric*$3::int)`, [o, p, qty, price])
        await owner.query("update dpg_app.orders set subtotal=2500,total=2500 where id=$1", [orderA])
        const quote = async (n: string, name: string, phone: string, assigned: number | null) => (await owner.query(
          `insert into dpg_app.quote_requests(quote_number, name, phone, email, assigned_to) values ($1::text,$2::text,$3::text,$2::text||'@example.test',$4::int) returning id`, [n, name, phone, assigned])).rows[0].id as number
        quoteA = await quote('BG-A', 'Anh Một', '0911000001', saleId); quoteB = await quote('BG-B', 'Chị Hai', '0911000002', null)
        await owner.query(`insert into dpg_app.quote_items(quote_id, product_id, quantity, product_name_snapshot, sale_price_snapshot, snapshot_at) values ($1,1,2,'Snapshot 1',1500,now()), ($1,2,1,null,null,null), ($2,3,1,'Snapshot 3',900,now())`, [quoteA, quoteB])
      })

      it('shows sale users only their assigned orders and hides the rest', async () => {
        const sale = await token('sale'), manager = await token('manager'), admin = await token('admin')
        const mine = await call('GET', '/orders', undefined, { token: sale })
        expect(mine.json.data.items.map((o: { id: number }) => o.id)).toEqual([orderA]); expect(mine.json.data.stats.total).toBe(1)
        expect(JSON.stringify(mine.json)).not.toMatch(/internal_note|owner_id|secret/)
        expect(code(await call('GET', `/orders/${orderB}`, undefined, { token: sale }))).toBe('NOT_FOUND')
        expect((await call('GET', `/orders/${orderA}`, undefined, { token: sale })).json.data).toMatchObject({ order_number: 'DPG-A', total: 2500 })
        expect((await call('GET', '/orders', undefined, { token: manager })).json.data.total).toBe(2)
        expect((await call('GET', `/orders/${orderA}`, undefined, { token: admin })).json.data.items).toHaveLength(2)
        expect(code(await call('PATCH', `/orders/${orderB}/status`, { status: 'received' }, { token: sale }))).toBe('NOT_FOUND')
        expect((await call('PATCH', `/orders/${orderA}/status`, { status: 'received' }, { token: sale })).json.data.status).toBe('received')
        for (const [route, body] of [[`/orders/${orderA}/payment`, { payment_status: 'paid' }], [`/orders/${orderA}/assign`, { user_id: null }], [`/orders/${orderA}`, { shipping_fee: 1 }]] as const) {
          expect(code(await call('PATCH', route, body, { token: sale })), route).toBe('FORBIDDEN')
        }
        expect(code(await call('PATCH', `/orders/${orderA}/payment`, { payment_status: 'paid' }, { token: manager }))).toBe('FORBIDDEN') // orders:edit is admin-only
        expect(code(await call('GET', '/orders/abc', undefined, { token: admin }))).toBe('NOT_FOUND')
        expect(code(await call('GET', '/orders?status=bogus', undefined, { token: admin }))).toBe('VALIDATION_FAILED')
        expect(code(await call('PATCH', `/orders/${orderA}/status`, { status: 'delivered' }, { token: admin }))).toBe('VALIDATION_FAILED')
        expect((await call('GET', '/orders?q=' + encodeURIComponent("x'; drop table dpg_app.orders;--"), undefined, { token: admin })).json.data.total).toBe(0)
        expect((await call('GET', '/orders?q=Kh%C3%A1ch%20B', undefined, { token: admin })).json.data.items[0].id).toBe(orderB)
      })

      it('assigns orders only to active staff and records the audit trail', async () => {
        const manager = await token('manager'), sale = await token('sale')
        const offId = await uid('off@example.test')
        expect(code(await call('PATCH', `/orders/${orderB}/assign`, { user_id: offId }, { token: manager }))).toBe('VALIDATION_FAILED')
        expect(code(await call('PATCH', `/orders/${orderB}/assign`, { user_id: 99999 }, { token: manager }))).toBe('VALIDATION_FAILED')
        expect((await call('PATCH', `/orders/${orderB}/assign`, { user_id: saleId }, { token: manager })).json.data).toMatchObject({ assigned_to: saleId })
        expect((await call('GET', `/orders/${orderB}`, undefined, { token: sale })).status).toBe(200) // now visible to the assignee
        expect((await call('PATCH', `/orders/${orderB}/assign`, { user_id: null }, { token: manager })).json.data).toMatchObject({ assigned_to: null, assigned_at: null })
        const actions = (await owner.query("select action from dpg_app.audit_logs where entity_type='orders' and entity_id=$1 order by id", [orderB])).rows.map((r) => r.action)
        expect(actions).toEqual(['orders.assign', 'orders.unassign'])
        expect((await call('GET', '/assignees', undefined, { token: manager })).json.data.items.map((u: { name: string }) => u.name)).not.toContain('Off')
        expect((await call('GET', '/assignees', undefined, { token: sale })).status).toBe(200) // quotes:update lets sales assign quotes (legacy parity)
        expect(code(await call('GET', '/assignees'))).toBe('UNAUTHENTICATED')
      })

      it('recomputes order totals on the server and rejects foreign lines', async () => {
        const admin = await token('admin')
        const detail = (await call('GET', `/orders/${orderA}`, undefined, { token: admin })).json.data
        const [i1, i2] = detail.items as { id: number }[]
        const edited = await call('PATCH', `/orders/${orderA}`, { items: [{ id: i1.id, unit_price: 2000, quantity: 3 }, { id: i2.id, unit_price: 1000, quantity: 1 }], vat_rate: 10, shipping_fee: 50000, discount: 10000, note: 'Giao giờ hành chính' }, { token: admin })
        expect(edited.status).toBe(200)
        expect(edited.json.data).toMatchObject({ subtotal: 7000, vat_rate: 10, shipping_fee: 50000, discount: 10000, total: 7000 + 700 + 50000 - 10000, note: 'Giao giờ hành chính' })
        const otherLine = (await call('GET', `/orders/${orderB}`, undefined, { token: admin })).json.data.items[0].id
        expect(code(await call('PATCH', `/orders/${orderA}`, { items: [{ id: otherLine, unit_price: 1, quantity: 1 }] }, { token: admin }))).toBe('VALIDATION_FAILED')
        expect(code(await call('PATCH', `/orders/${orderA}`, { discount: 999999 }, { token: admin }))).toBe('VALIDATION_FAILED')
        for (const bad of [{ vat_rate: 101 }, { shipping_fee: -1 }, { items: [{ id: i1.id, unit_price: -5, quantity: 1 }] }, { items: [{ id: i1.id, unit_price: 5, quantity: 0 }] }, { total: 1 }, { items: [{ id: i1.id, unit_price: 5, quantity: 1, total_price: 1 }] }]) {
          expect(code(await call('PATCH', `/orders/${orderA}`, bad, { token: admin })), JSON.stringify(bad)).toBe('VALIDATION_FAILED')
        }
        expect(Number((await owner.query('select total from dpg_app.orders where id=$1', [orderA])).rows[0].total)).toBe(7000 + 700 + 50000 - 10000) // failed edits changed nothing
        const paid = await call('PATCH', `/orders/${orderA}/payment`, { payment_status: 'paid' }, { token: admin })
        expect(paid.json.data.payment_status).toBe('paid')
      })

      it('limits quotes to the assignee, saves pricing, and completes with CSKH sync', async () => {
        const sale = await token('sale'), manager = await token('manager'), admin = await token('admin')
        const mine = await call('GET', '/quotes', undefined, { token: sale })
        expect(mine.json.data.items.map((q: { id: number }) => q.id)).toEqual([quoteA]); expect(mine.json.data.counts).toEqual({ pending: 1 })
        expect(mine.json.data.items[0].item_names).toContain('Snapshot 1')
        expect(code(await call('GET', `/quotes/${quoteB}`, undefined, { token: sale }))).toBe('NOT_FOUND')
        expect(code(await call('PATCH', `/quotes/${quoteB}/status`, { status: 'cancelled' }, { token: sale }))).toBe('NOT_FOUND')
        const all = await call('GET', '/quotes?status=pending', undefined, { token: manager }); expect(all.json.data.total).toBe(2)
        const detail = (await call('GET', `/quotes/${quoteA}`, undefined, { token: manager })).json.data
        expect(detail.items).toHaveLength(2); expect(detail.items[0]).toMatchObject({ product_name_snapshot: 'Snapshot 1', sale_price_snapshot: 1500 })
        const [q1, q2] = detail.items as { id: number }[]
        const saved = await call('PATCH', `/quotes/${quoteA}`, { vat_rate: 8, shipping_fee: 30000, admin_notes: 'Giá đã gồm VAT', items: [{ id: q1.id, admin_unit_price: 1400, admin_quantity: 2 }, { id: q2.id, admin_unit_price: 600 }] }, { token: manager })
        expect(saved.json.data).toMatchObject({ vat_rate: 8, shipping_fee: 30000, status: 'resolved', admin_notes: 'Giá đã gồm VAT' })
        const after = (await call('GET', `/quotes/${quoteA}`, undefined, { token: manager })).json.data.items
        expect(after[0]).toMatchObject({ admin_unit_price: 1400, admin_quantity: 2 }); expect(after[1]).toMatchObject({ admin_unit_price: 600, admin_quantity: null })
        const foreign = (await call('GET', `/quotes/${quoteB}`, undefined, { token: manager })).json.data.items[0].id
        expect(code(await call('PATCH', `/quotes/${quoteA}`, { items: [{ id: foreign, admin_unit_price: 1 }] }, { token: manager }))).toBe('VALIDATION_FAILED')
        expect(code(await call('PATCH', `/quotes/${quoteA}`, { name: 'Hacker' }, { token: manager }))).toBe('VALIDATION_FAILED')

        const done = await call('POST', `/quotes/${quoteA}/complete`, { items: [], admin_notes: 'Xong' }, { token: sale })
        expect(done.json.data).toMatchObject({ status: 'completed', admin_notes: 'Xong' }); expect(done.json.data.customer_id).toBeTruthy()
        const customer = (await owner.query('select full_name, source, notes from dpg_app.customers where id=$1', [done.json.data.customer_id])).rows[0]
        expect(customer).toMatchObject({ full_name: 'Anh Một', source: 'QUOTE_FORM' }); expect(customer.notes).toContain('BG-A')
        // an existing customer with the same phone is linked and its notes appended (not duplicated)
        await owner.query("insert into dpg_app.customers(full_name, phone, notes) values ('Chị Hai (cũ)','0911000002','Ghi chú cũ')")
        const second = await call('POST', `/quotes/${quoteB}/complete`, { items: [] }, { token: admin })
        expect(Number((await owner.query("select count(*) from dpg_app.customers where phone='0911000002'")).rows[0].count)).toBe(1)
        expect((await owner.query('select notes from dpg_app.customers where id=$1', [second.json.data.customer_id])).rows[0].notes).toBe('Ghi chú cũ\n---\nNhận báo giá #BG-B')
        expect(code(await call('PATCH', `/quotes/${quoteB}/status`, { status: 'archived' }, { token: admin }))).toBe('VALIDATION_FAILED')
        expect((await call('PATCH', `/quotes/${quoteB}/assign`, { user_id: managerId }, { token: manager })).json.data.assigned_to).toBe(managerId)
        expect((await call('PATCH', `/quotes/${quoteB}`, { vat_rate: 5 }, { token: admin })).json.data.status).toBe('completed') // saving never reopens a finished quote
      })

      it('serves the dashboard to roles with dashboard:read only', async () => {
        const admin = await token('admin'), manager = await token('manager'), sale = await token('sale')
        const d = await call('GET', '/dashboard?period=week', undefined, { token: manager })
        expect(d.status).toBe(200); expect(d.json.data.stats).toMatchObject({ pending_orders: 1, pending_quotes: 0, total_products: 30, active_products: 30 }); expect(d.json.data.period).toBe('week')
        expect(Array.isArray(d.json.data.revenue)).toBe(true); expect(d.json.data.top_quoted.length).toBeGreaterThan(0)
        expect(code(await call('GET', '/dashboard', undefined, { token: sale }))).toBe('FORBIDDEN')
        expect(code(await call('GET', '/dashboard?period=decade', undefined, { token: admin }))).toBe('VALIDATION_FAILED')
        expect(code(await call('GET', "/dashboard?period=day'; drop table dpg_app.orders;--", undefined, { token: admin }))).toBe('VALIDATION_FAILED')
        await owner.query("update dpg_app.orders set status='completed', payment_status='paid', total=1000 where id=$1", [orderB])
        const month = (await call('GET', '/dashboard', undefined, { token: admin })).json.data
        expect(month.stats.revenue_this_month).toBeGreaterThanOrEqual(1000); expect(month.revenue.reduce((s: number, r: { revenue: number }) => s + r.revenue, 0)).toBeGreaterThanOrEqual(1000)
        expect(month.top_sold[0]).toMatchObject({ total_sold: expect.any(Number) })
      })

      it('keeps commerce tables write-protected at the database level', async () => {
        for (const statement of [
          'select owner_id from dpg_app.orders', 'select internal_note from dpg_app.orders', "update dpg_app.orders set order_number = 'x'", "update dpg_app.orders set customer_name = 'x'",
          'delete from dpg_app.orders', "insert into dpg_app.orders(order_number) values ('x')", 'delete from dpg_app.order_items', "update dpg_app.order_items set product_name = 'x'",
          "update dpg_app.quote_requests set name = 'x'", "update dpg_app.quote_requests set phone = 'x'", 'delete from dpg_app.quote_requests', "insert into dpg_app.quote_requests(name, phone) values ('x','y')",
          'select owner_id from dpg_app.quote_requests', "update dpg_app.quote_items set product_id = 1", 'delete from dpg_app.quote_items', 'update dpg_app.quote_items set list_price_snapshot = 1',
        ]) await expect(apiPool.query(statement), statement).rejects.toThrow(/permission denied/)
      })
    })

    describe('products', () => {
      const code2 = code
      it('creates products with identity fixed afterwards, price rules and activation guards', async () => {
        const t = await token('admin'), sale = await token('sale')
        const base = { sku: 'NEW-1', name: 'Bồn cầu mới', slug: 'bon-cau-moi', category_id: 1, price_display: 'Liên hệ báo giá' }
        expect(code2(await call('POST', '/r/products', { input: base }, { token: sale }))).toBe('FORBIDDEN')
        const created = await call('POST', '/r/products', { input: { ...base, is_active: false, brand_id: 1, origin_id: 1, specs: { color: 'white' }, description: '<p>Mô tả</p>' } }, { token: t })
        expect(created.status).toBe(201); expect(created.json.data).toMatchObject({ sku: 'NEW-1', slug: 'bon-cau-moi', is_active: false, version: 1, specs: { color: 'white' }, stock_status: 'in_stock' })
        const id = created.json.data.id
        expect(code2(await call('POST', '/r/products', { input: { ...base } }, { token: t }))).toBe('DUPLICATE')
        expect(code2(await call('POST', '/r/products', { input: { ...base, sku: 'NEW-2', slug: 'new-2', is_active: true } }, { token: t }))).toBe('PRICE_REQUIRED')
        expect(code2(await call('POST', '/r/products', { input: { ...base, sku: 'NEW-3', slug: 'new-3', is_active: true, price: 1000 } }, { token: t }))).toBe('IMAGE_REQUIRED')
        const ok = await call('POST', '/r/products', { input: { ...base, sku: 'NEW-4', slug: 'new-4', is_active: true, price: 1000, image_main_url: `${MEDIA}/products/a.webp` } }, { token: t })
        expect(ok.status).toBe(201)
        expect((await call('POST', '/r/products', { input: { ...base, sku: 'NEW-5', slug: 'new-5', is_active: true, stock_status: 'contact', image_main_url: `${MEDIA}/products/b.webp` } }, { token: t })).status).toBe(201) // "contact for quote" needs no price
        expect(code2(await call('POST', '/r/products', { input: { ...base, sku: 'NEW-6', slug: 'new-6', list_price: 100, sale_price: 100 } }, { token: t }))).toBe('SALE_PRICE_INVALID')
        expect(code2(await call('POST', '/r/products', { input: { ...base, sku: 'NEW-7', slug: 'new-7', sale_price: 50 } }, { token: t }))).toBe('SALE_PRICE_INVALID')
        for (const bad of [{ category_id: 'x' }, { price: -1 }, { stock_status: 'lost' }, { image_main_url: 'https://evil.example/x.webp' }, { version: 3 }, { source_url: 'javascript:alert(1)' }, { specs: [] }, { description: '<script>alert(1)</script>' }]) {
          expect(code2(await call('POST', '/r/products', { input: { ...base, sku: 'BAD', slug: 'bad', ...bad } }, { token: t })), JSON.stringify(bad)).toBe('VALIDATION_FAILED')
        }
        expect(code2(await call('POST', '/r/products', { input: { ...base, sku: 'FK', slug: 'fk', category_id: 999 } }, { token: t }))).toBe('REFERENCE_CONFLICT')

        // sku/slug are create-only; price edits keep the pricing invariants; optimistic version applies
        for (const input of [{ sku: 'X' }, { slug: 'x' }]) expect(code2(await call('PATCH', `/r/products/${id}`, { expected_version: 1, input }, { token: t }))).toBe('VALIDATION_FAILED')
        const priced = await call('PATCH', `/r/products/${id}`, { expected_version: 1, input: { price: 2500000, list_price: 3000000, sale_price: 2500000, price_display: '2.500.000đ' } }, { token: t })
        expect(priced.json.data).toMatchObject({ price: '2500000', version: 2, price_display: '2.500.000đ' })
        expect(code2(await call('PATCH', `/r/products/${id}`, { expected_version: 2, input: { sale_price: 3000000 } }, { token: t }))).toBe('SALE_PRICE_INVALID')
        expect(code2(await call('PATCH', `/r/products/${id}`, { expected_version: 2, input: { is_active: true } }, { token: t }))).toBe('IMAGE_REQUIRED')
        expect(code2(await call('PATCH', `/r/products/${id}`, { expected_version: 1, input: { name: 'Stale' } }, { token: t }))).toBe('VERSION_CONFLICT')
        // #446 canonical Hita prices: whole positive VND, promo < regular, voucher < (promo ?? regular), both need a regular price
        const canon = (input: Record<string, unknown>, v: number) => call('PATCH', `/r/products/${id}`, { expected_version: v, input }, { token: t })
        expect(code2(await canon({ promotional_price_vnd: 800000 }, 2))).toBe('PRICE_RELATION_INVALID') // no regular price
        expect(code2(await canon({ regular_price_vnd: 1000000, promotional_price_vnd: 1000000 }, 2))).toBe('PRICE_RELATION_INVALID')
        expect(code2(await canon({ regular_price_vnd: 1000000, promotional_price_vnd: 900000, online_voucher_amount_vnd: 900000 }, 2))).toBe('VOUCHER_INVALID')
        expect(code2(await canon({ online_voucher_amount_vnd: 50000 }, 2))).toBe('VOUCHER_INVALID') // no regular price
        expect(code2(await canon({ regular_price_vnd: 1000000.5 }, 2))).toBe('PRICE_RELATION_INVALID') // not whole VND
        expect(code2(await canon({ regular_price_vnd: 0 }, 2))).toBe('VALIDATION_FAILED')
        expect(code2(await canon({ regular_price_vnd: -5 }, 2))).toBe('VALIDATION_FAILED')
        expect(code2(await call('PATCH', `/r/products/${id}`, { expected_version: 2, input: { regular_price_vnd: 1000000 } }, { token: sale }))).toBe('FORBIDDEN') // commerce:write only
        const canonOk = await canon({ regular_price_vnd: 1000000, promotional_price_vnd: 900000, online_voucher_amount_vnd: 50000 }, 2)
        expect(canonOk.status).toBe(200)
        expect(canonOk.json.data).toMatchObject({ regular_price_vnd: '1000000', promotional_price_vnd: '900000', online_voucher_amount_vnd: '50000', version: 3 })
        // legacy columns untouched by the canonical write; GET confirms saved values
        expect((await call('GET', `/r/products/${id}`, undefined, { token: t })).json.data).toMatchObject({ regular_price_vnd: '1000000', promotional_price_vnd: '900000', online_voucher_amount_vnd: '50000', price: '2500000' })
        expect((await canon({ promotional_price_vnd: null, online_voucher_amount_vnd: null }, 3)).json.data).toMatchObject({ regular_price_vnd: '1000000', promotional_price_vnd: null, online_voucher_amount_vnd: null, version: 4 })
        const cleared = await call('PATCH', `/r/products/${id}`, { expected_version: 4, input: { sale_price: null, list_price: null, brand_id: null, description: '' } }, { token: t })
        expect(cleared.json.data).toMatchObject({ sale_price: null, list_price: null, brand_id: null, description: null, version: 5 })
        // identity and untouched columns stay as they were
        expect((await owner.query('select sku, slug from dpg_app.products where id=$1', [id])).rows[0]).toEqual({ sku: 'NEW-1', slug: 'bon-cau-moi' })
        expect((await call('GET', '/r/products?q=bon-cau-moi&category_id=1&is_active=false', undefined, { token: t })).json.data.total).toBe(1)
        const audit = (await owner.query("select action from dpg_app.audit_logs where entity_type='products' and entity_id=$1 order by id", [id])).rows
        expect(audit.map((a) => a.action)).toEqual(['products.create', 'products.update', 'products.update', 'products.update', 'products.update'])
        expect(code2(await call('DELETE', `/r/products/${id}`, {}, { token: sale }))).toBe('FORBIDDEN')
        expect(code2(await call('DELETE', `/r/products/${id}`, {}, { token: t }))).toBe('VALIDATION_FAILED') // version required
        expect((await call('DELETE', `/r/products/${id}`, { expected_version: 5 }, { token: t })).json.data.result).toBe('deleted')
        expect(code2(await call('DELETE', '/r/products/1', { expected_version: 1 }, { token: t }))).not.toBe('NOT_FOUND')
      })

      it('applies bulk product actions with the activation guard and audit', async () => {
        const t = await token('admin'), sale = await token('sale')
        await owner.query("update dpg_app.products set is_active=false, image_main_url=null, price=null, list_price=null, sale_price=null where id in (10, 11, 12)")
        await owner.query("update dpg_app.products set image_main_url='https://media.example.test/p.webp', price=900 where id=11")
        expect(code2(await call('POST', '/products/bulk', { ids: [10], action: 'activate' }, { token: sale }))).toBe('FORBIDDEN')
        for (const bad of [{ ids: [], action: 'activate' }, { ids: [1], action: 'drop' }, { ids: Array.from({ length: 101 }, (_, i) => i + 1), action: 'feature' }, { ids: [1], action: 'feature', extra: 1 }]) {
          expect(code2(await call('POST', '/products/bulk', bad, { token: t })), JSON.stringify(bad)).toBe('VALIDATION_FAILED')
        }
        const activated = await call('POST', '/products/bulk', { ids: [10, 11, 12, 99999], action: 'activate' }, { token: t })
        expect(activated.json.data.updated).toBe(1)
        expect(activated.json.data.skipped).toEqual(expect.arrayContaining([{ id: 10, reason: 'PRICE_REQUIRED' }, { id: 12, reason: 'PRICE_REQUIRED' }, { id: 99999, reason: 'NOT_FOUND' }]))
        expect((await owner.query('select id, is_active from dpg_app.products where id in (10,11,12) order by id')).rows.map((r) => r.is_active)).toEqual([false, true, false])
        expect((await call('POST', '/products/bulk', { ids: [10, 11], action: 'feature' }, { token: t })).json.data.updated).toBe(2)
        expect((await owner.query('select count(*) from dpg_app.products where id in (10,11) and is_featured')).rows[0].count).toBe('2')
        expect((await call('POST', '/products/bulk', { ids: [10, 11], action: 'deactivate' }, { token: t })).json.data.updated).toBe(2)
        const audits = (await owner.query("select action from dpg_app.audit_logs where entity_type='products' and action like 'products.bulk_%' and entity_id=11 order by id")).rows.map((r) => r.action)
        expect(audits).toEqual(['products.bulk_activate', 'products.bulk_feature', 'products.bulk_deactivate'])
        expect(code2(await call('POST', '/products/bulk', { ids: [10], action: 'delete' }, { token: sale }))).toBe('FORBIDDEN')
        expect((await call('POST', '/products/bulk', { ids: [12], action: 'delete' }, { token: t })).json.data.updated).toBe(1)
      })

      it('manages product documents, spec values, taxon assignments and relations as child records', async () => {
        const t = await token('admin'), manager = await token('manager')
        // documents: https only, never local hosts or credentials; documents:write is admin-only
        const doc = await call('POST', '/r/product-documents', { input: { product_id: 2, name: 'Catalogue', url: 'https://docs.example.test/a.pdf', file_ext: 'pdf', file_size: 1024 } }, { token: t })
        expect(doc.status).toBe(201); expect(doc.json.data).toMatchObject({ document_type: 'DOCUMENT', product_id: 2, file_size: 1024 })
        for (const url of ['http://docs.example.test/a.pdf', 'https://localhost/a.pdf', 'https://user:pw@docs.example.test/a.pdf', 'javascript:alert(1)', '/relative.pdf']) {
          expect(code2(await call('POST', '/r/product-documents', { input: { product_id: 2, name: 'x', url } }, { token: t })), url).toBe('VALIDATION_FAILED')
        }
        expect(code2(await call('POST', '/r/product-documents', { input: { product_id: 2, name: 'x', url: 'https://docs.example.test/b.pdf', file_size: -1 } }, { token: t }))).toBe('VALIDATION_FAILED')
        expect(code2(await call('POST', '/r/product-documents', { input: { product_id: 9999, name: 'x', url: 'https://docs.example.test/c.pdf' } }, { token: t }))).toBe('REFERENCE_CONFLICT')
        expect(code2(await call('POST', '/r/product-documents', { input: { product_id: 2, name: 'x', url: 'https://docs.example.test/d.pdf' } }, { token: manager }))).toBe('FORBIDDEN')
        expect((await call('GET', '/r/product-documents?product_id=2', undefined, { token: manager })).json.data.total).toBe(1)
        expect(code2(await call('PATCH', `/r/product-documents/${doc.json.data.id}`, { input: { product_id: 3 } }, { token: t }))).toBe('VALIDATION_FAILED')
        expect((await call('PATCH', `/r/product-documents/${doc.json.data.id}`, { input: { name: 'Catalogue 2025', source_url: 'https://src.example.test/a' } }, { token: t })).json.data).toMatchObject({ name: 'Catalogue 2025' })
        expect((await call('DELETE', `/r/product-documents/${doc.json.data.id}`, {}, { token: t })).json.data.result).toBe('deleted')

        // spec values (numeric + JSON + option), taxon assignments, relationships (auto sort order, unique per type)
        const spec = Number((await owner.query("insert into dpg_app.spec_definitions(key,label) values ('dung-tich','Dung tích') returning id")).rows[0].id) // master data is Dev-managed: fixture inserted as owner
        const sv = await call('POST', '/r/product-spec-values', { input: { product_id: 2, spec_definition_id: spec, value_number: -1.5, value_json: { unit: 'l' }, raw_key: 'Dung tích' } }, { token: t })
        expect(sv.status).toBe(201); expect(sv.json.data).toMatchObject({ value_number: '-1.5', value_json: { unit: 'l' } })
        expect(code2(await call('POST', '/r/product-spec-values', { input: { product_id: 2, spec_definition_id: 9999 } }, { token: t }))).toBe('REFERENCE_CONFLICT')
        expect((await call('PATCH', `/r/product-spec-values/${sv.json.data.id}`, { input: { value_json: null, value_text: '6 lít' } }, { token: t })).json.data).toMatchObject({ value_json: null, value_text: '6 lít' })
        const taxon = Number((await owner.query("insert into dpg_app.catalog_taxons(name,slug,canonical_path) values ('Bồn cầu','bon-cau-x','/bon-cau-x') returning id")).rows[0].id)
        const ta = await call('POST', '/r/product-taxon-assignments', { input: { product_id: 2, taxon_id: taxon, is_primary: true } }, { token: t })
        expect(ta.json.data).toMatchObject({ is_primary: true, taxon_id: taxon })
        expect(code2(await call('POST', '/r/product-taxon-assignments', { input: { product_id: 2, taxon_id: 9999 } }, { token: t }))).toBe('REFERENCE_CONFLICT')
        const r1 = await call('POST', '/r/product-relationships', { input: { parent_id: 2, child_sku: 'SKU-3', child_id: 3 } }, { token: t })
        const r2 = await call('POST', '/r/product-relationships', { input: { parent_id: 2, child_sku: 'SKU-4', child_id: 4, quantity: 2 } }, { token: t })
        expect([r1.json.data.sort_order, r2.json.data.sort_order]).toEqual([0, 1]); expect(r1.json.data).toMatchObject({ relationship_type: 'component', resolution_status: 'unresolved' })
        expect(code2(await call('POST', '/r/product-relationships', { input: { parent_id: 2, child_sku: 'SKU-3' } }, { token: t }))).toBe('DUPLICATE')
        expect(code2(await call('PATCH', `/r/product-relationships/${r1.json.data.id}`, { input: { resolution_status: 'resolved' } }, { token: t }))).toBe('VALIDATION_FAILED')
        expect((await call('GET', '/r/product-relationships?parent_id=2', undefined, { token: manager })).json.data.total).toBe(2)
        for (const [key, id] of [['product-relationships', r1.json.data.id], ['product-taxon-assignments', ta.json.data.id], ['product-spec-values', sv.json.data.id]] as const) expect((await call('DELETE', `/r/${key}/${id}`, {}, { token: t })).json.data.result).toBe('deleted')
        await expect(apiPool.query("update dpg_app.product_taxon_assignments set metadata = '{}'::jsonb"), 'metadata').rejects.toThrow(/permission denied/)
        await expect(apiPool.query("update dpg_app.product_spec_values set source = 'x'"), 'source').rejects.toThrow(/permission denied/)
      })

      it('links and unlinks product variants (groups created on demand, versions bumped, audited)', async () => {
        const t = await token('admin'), manager = await token('manager'), sale = await token('sale')
        await owner.query("update dpg_app.products set color_id=1 where id in (20,21,22)")
        expect((await call('GET', '/products/20/variants', undefined, { token: sale })).json.data).toEqual({ group: null, items: [] })
        expect(code2(await call('POST', '/products/20/variants', { target_id: 21 }, { token: manager }))).toBe('FORBIDDEN')
        expect(code2(await call('POST', '/products/20/variants', { target_id: 20 }, { token: t }))).toBe('VALIDATION_FAILED')
        expect(code2(await call('POST', '/products/20/variants', { target_id: 99999 }, { token: t }))).toBe('NOT_FOUND')
        expect(code2(await call('POST', '/products/20/variants', { target_id: 21, extra: 1 }, { token: t }))).toBe('VALIDATION_FAILED')
        const before = (await owner.query('select id, version from dpg_app.products where id in (20,21,22) order by id')).rows
        const linked = await call('POST', '/products/20/variants', { target_id: 21 }, { token: t })
        expect(linked.json.data.group).toMatch(/^VG-\d{10,}$/)
        expect((await call('POST', '/products/20/variants', { target_id: 22 }, { token: t })).json.data.group).toBe(linked.json.data.group)
        const group = (await call('GET', '/products/21/variants', undefined, { token: manager })).json.data
        expect(group.group).toBe(linked.json.data.group); expect(group.items.map((i: { id: number }) => i.id)).toEqual([20, 21, 22]); expect(group.items[0]).toMatchObject({ sku: 'SKU-20', color_name: 'Trắng' })
        const after = (await owner.query('select id, version from dpg_app.products where id in (20,21,22) order by id')).rows
        expect(after[0].version).toBe(before[0].version + 1); expect(after[1].version).toBe(before[1].version + 1); expect(after[2].version).toBe(before[2].version + 1)
        expect(code2(await call('DELETE', '/products/20/variants/21', {}, { token: manager }))).toBe('FORBIDDEN')
        expect((await call('DELETE', '/products/20/variants/21', {}, { token: t })).json.data.ok).toBe(true)
        expect((await call('GET', '/products/20/variants', undefined, { token: t })).json.data.items.map((i: { id: number }) => i.id)).toEqual([20, 22])
        expect((await owner.query('select variant_group from dpg_app.products where id=21')).rows[0].variant_group).toBeNull()
        const actions = (await owner.query("select action from dpg_app.audit_logs where entity_type='products' and action like 'products.variant_%' order by id")).rows.map((r) => r.action)
        expect(actions).toEqual(['products.variant_link', 'products.variant_link', 'products.variant_link', 'products.variant_unlink'])
        await expect(apiPool.query("update dpg_app.products set variant_type = 'x'"), 'variant_type').rejects.toThrow(/permission denied|does not exist/)
      })

      it('manages gallery images and lookups', async () => {
        const t = await token('admin'), sale = await token('sale')
        const img = await call('POST', '/r/product-images', { input: { product_id: 2, image_url: `${MEDIA}/products/g1.webp`, alt_text: 'Góc nhìn 1', sort_order: 1 } }, { token: t })
        expect(img.status).toBe(201); expect(img.json.data).toMatchObject({ product_id: 2, image_type: 'gallery', sort_order: 1 })
        expect(code2(await call('POST', '/r/product-images', { input: { product_id: 2, image_url: 'https://evil.example/g.webp' } }, { token: t }))).toBe('VALIDATION_FAILED')
        expect(code2(await call('POST', '/r/product-images', { input: { product_id: 9999, image_url: `${MEDIA}/products/g2.webp` } }, { token: t }))).toBe('REFERENCE_CONFLICT')
        expect(code2(await call('PATCH', `/r/product-images/${img.json.data.id}`, { input: { product_id: 3 } }, { token: t }))).toBe('VALIDATION_FAILED')
        expect((await call('PATCH', `/r/product-images/${img.json.data.id}`, { input: { sort_order: 0, alt_text: '' } }, { token: t })).json.data).toMatchObject({ sort_order: 0, alt_text: null })
        expect((await call('GET', '/r/product-images?product_id=2', undefined, { token: sale })).json.data.total).toBe(1)
        expect(code2(await call('POST', '/r/product-images', { input: { product_id: 2, image_url: `${MEDIA}/products/g3.webp` } }, { token: sale }))).toBe('FORBIDDEN')
        expect((await call('DELETE', `/r/product-images/${img.json.data.id}`, {}, { token: t })).json.data.result).toBe('deleted')
        for (const key of ['origins', 'colors', 'materials']) expect((await call('GET', `/r/${key}/options`, undefined, { token: sale })).json.data.items.length).toBeGreaterThan(0)
        expect(code2(await call('POST', '/r/colors', { input: { name: 'x' } }, { token: t }))).toBe('DEV_MANAGED')
      })
    })

    it('#470: Production status column — hook keeps status in step with prices through the real handler; legacy guards still apply', async () => {
      const t = await token('admin'), sale = await token('sale')
      // The Production 001 CHECK + 002 column grants (status/checked_at), applied to the TEST-shaped fixture (guards need the Production contract).
      const check = /add constraint products_canonical_price_check check \(([\s\S]*?)\) not valid;/.exec(await readFile(path.join(root, 'supabase/prod-prep/470/001_canonical_price_columns.sql'), 'utf8'))![1]
      await owner.query('alter table dpg_app.products add column if not exists canonical_price_status text, add column if not exists canonical_price_checked_at timestamptz')
      await owner.query(`alter table dpg_app.products drop constraint if exists products_canonical_price_check, add constraint products_canonical_price_check check (${check})`)
      await owner.query(`grant select, insert, update (canonical_price_status, canonical_price_checked_at) on dpg_app.products to ${apiRole}`)
      setExternalColumns(['regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd', 'canonical_price_status', 'canonical_price_checked_at'])
      // brand/category identity the scope check reads: sanitary x approved brands (TOTO, INAX); American Standard stays on legacy prices
      await owner.query("update dpg_app.categories set slug='thiet-bi-ve-sinh' where id=1; insert into dpg_app.brands(name,slug) values ('TOTO','toto'),('American Standard','american-standard') on conflict do nothing")
      const brandId = async (slug: string) => Number((await owner.query('select id from dpg_app.brands where slug=$1', [slug])).rows[0].id)
      try {
        const made = await call('POST', '/r/products', { input: { sku: 'C470-1', name: 'TOTO canonical', slug: 'c470-1', category_id: 1, brand_id: await brandId('toto'), price_display: 'Liên hệ báo giá', is_active: false } }, { token: t })
        expect(made.status).toBe(201); const id = made.json.data.id
        const patch = (input: Record<string, unknown>, v: number, tok = t) => call('PATCH', `/r/products/${id}`, { expected_version: v, input }, { token: tok })
        // mixed update: canonical price + an invalid legacy sale price is still rejected (no bypass), nothing is written
        expect(code(await patch({ regular_price_vnd: 1000000, list_price: 100, sale_price: 200 }, 1))).toBe('SALE_PRICE_INVALID')
        // activation guard still runs together with a canonical edit
        expect(code(await patch({ regular_price_vnd: 1000000, is_active: true }, 1))).toBe('IMAGE_REQUIRED')
        expect((await owner.query('select canonical_price_status, regular_price_vnd, version from dpg_app.products where id=$1', [id])).rows[0]).toEqual({ canonical_price_status: null, regular_price_vnd: null, version: 1 })
        // status is read-only for the user; sale role has no commerce:write
        expect(code(await patch({ canonical_price_status: 'PRICE_VERIFIED' }, 1))).toBe('VALIDATION_FAILED')
        expect(code(await patch({ regular_price_vnd: 1000000 }, 1, sale))).toBe('FORBIDDEN')
        const ok = await patch({ regular_price_vnd: 1000000, promotional_price_vnd: 900000 }, 1)
        expect(ok.status).toBe(200)
        const row = (await owner.query('select canonical_price_status, canonical_price_checked_at is not null as stamped, version from dpg_app.products where id=$1', [id])).rows[0]
        expect(row).toEqual({ canonical_price_status: 'PRICE_VERIFIED', stamped: true, version: 2 })
        // #470 (Owner 24/11): approved prices are DPG's official prices. Re-activating never hides/downgrades a price because of its age.
        await owner.query("update dpg_app.products set canonical_price_checked_at = now() - interval '300 days', image_main_url = $2 where id=$1", [id, `${MEDIA}/products/a.webp`])
        const reactivated = await patch({ is_active: true }, 2)
        expect(reactivated.status).toBe(200)
        const kept = (await owner.query("select is_active, canonical_price_status, regular_price_vnd, promotional_price_vnd, extract(epoch from now() - canonical_price_checked_at) / 86400 as age_days, version from dpg_app.products where id=$1", [id])).rows[0]
        expect({ is_active: kept.is_active, status: kept.canonical_price_status, regular: kept.regular_price_vnd, promo: kept.promotional_price_vnd, version: kept.version }).toEqual({ is_active: true, status: 'PRICE_VERIFIED', regular: '1000000', promo: '900000', version: 3 })
        expect(Number(kept.age_days)).toBeGreaterThan(299)                                   // checked-at kept as is: the source age is evidence, not a deadline
        // an Admin edit of the prices re-stamps the check time (PRICE_VERIFIED + fresh checked-at)
        expect((await patch({ regular_price_vnd: 1000000, promotional_price_vnd: 900000 }, 3)).status).toBe(200)
        expect((await owner.query('select canonical_price_status, extract(epoch from now() - canonical_price_checked_at) < 60 as fresh from dpg_app.products where id=$1', [id])).rows[0]).toEqual({ canonical_price_status: 'PRICE_VERIFIED', fresh: true })
        expect((await patch({ is_active: false }, 4)).status).toBe(200)
        // a fresh verified price re-activates untouched (no status change)
        expect((await patch({ is_active: true }, 5)).status).toBe(200)
        expect((await owner.query('select canonical_price_status from dpg_app.products where id=$1', [id])).rows[0].canonical_price_status).toBe('PRICE_VERIFIED')
        expect((await patch({ is_active: false }, 6)).status).toBe(200)
        // clearing every canonical price hides the price again (status NULL), the CHECK never fires
        expect((await patch({ regular_price_vnd: null, promotional_price_vnd: null }, 7)).status).toBe(200)
        expect((await owner.query('select canonical_price_status, version from dpg_app.products where id=$1', [id])).rows[0]).toEqual({ canonical_price_status: null, version: 8 })
        // another sanitary brand cannot receive canonical prices (legacy price management untouched)
        await owner.query('update dpg_app.products set brand_id=$2 where id=$1', [id, await brandId('american-standard')])
        expect(code(await patch({ regular_price_vnd: 1000000 }, 8))).toBe('PRICE_SCOPE_INVALID')
        expect((await patch({ price: 1000, stock_status: 'in_stock' }, 8)).status).toBe(200)
        const audit = (await owner.query("select action from dpg_app.audit_logs where entity_type='products' and entity_id=$1 order by id", [id])).rows.map(r => r.action)
        expect(audit).toEqual(['products.create', ...Array(8).fill('products.update')])
      } finally {
        await owner.query("update dpg_app.categories set slug='cat' where id=1; delete from dpg_app.products where sku='C470-1'; delete from dpg_app.brands where slug in ('toto','american-standard')")
        await owner.query(`revoke select, insert, update (canonical_price_status, canonical_price_checked_at) on dpg_app.products from ${apiRole}`)
        await owner.query('alter table dpg_app.products drop constraint if exists products_canonical_price_check, drop column if exists canonical_price_status, drop column if exists canonical_price_checked_at')
        // restore exactly what the handler's own probe would see now
        setExternalColumns((await owner.query("select column_name from information_schema.columns where table_schema='dpg_app' and table_name='products' and column_name = any($1::text[])", [['regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd', 'canonical_price_status']])).rows.map(r => r.column_name))
      }
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
