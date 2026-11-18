// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleAdminNext, isAdminNextPath } from './m3-admin-gateway.mjs'
import { readFileSync } from 'node:fs'
import { verifyEnvelope, routeOf } from './m3-admin-envelope.mjs'

const ORIGIN = 'https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev'
const FN = 'https://uybumsnyqpwcidjxmfsv.supabase.co/functions/v1/admin-api'
const SECRET = 's'.repeat(40)
const TOKEN = 'ab'.repeat(32)
const environment = (extra = {}) => ({
  ADMIN_API_URL: FN, ADMIN_API_HMAC_SECRET: SECRET,
  ASSETS: { fetch: vi.fn(async () => new Response('<!doctype html><title>shell</title>', { status: 200, headers: { 'content-type': 'text/html' } })) },
  ...extra,
})
const ctx = { sourceSha: 'a'.repeat(40), stagingOrigin: ORIGIN }
const browser = (path, init = {}) => new Request(ORIGIN + path, {
  ...init, headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...(init.headers ?? {}) },
})
let calls
afterEach(() => vi.unstubAllGlobals())
function stubUpstream(response) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => { calls.push({ url, init }); return typeof response === 'function' ? response(url, init) : response.clone() }))
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('Admin shell gateway', () => {
  it('uses an envelope byte-identical to the function copy (single source of truth)', () => {
    expect(readFileSync('apps/public/m3-admin-envelope.mjs', 'utf8')).toBe(readFileSync('supabase/functions/admin-api/envelope.mjs', 'utf8'))
  })

  it('only owns /admin-next', () => {
    expect(isAdminNextPath('/admin-next')).toBe(true); expect(isAdminNextPath('/admin-next/products/1')).toBe(true)
    expect(isAdminNextPath('/admin')).toBe(false); expect(isAdminNextPath('/admin-nextx')).toBe(false)
  })

  it('serves the SPA shell for deep links, never for files or mutations', async () => {
    const env = environment()
    const page = await handleAdminNext(new Request(ORIGIN + '/admin-next/products/5'), env, ctx)
    expect(page.status).toBe(200); expect(page.headers.get('cache-control')).toBe('private, no-store'); expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(env.ASSETS.fetch.mock.calls[0][0].url).toBe(ORIGIN + '/admin-next/')
    expect((await handleAdminNext(new Request(ORIGIN + '/admin-next/missing.js'), env, ctx)).status).toBe(404)
    expect((await handleAdminNext(new Request(ORIGIN + '/admin-next/products', { method: 'POST' }), env, ctx)).status).toBe(405)
  })

  it('rejects unknown routes/methods and cross-site mutations before contacting the function', async () => {
    stubUpstream(json({ data: {} }))
    const env = environment()
    expect((await handleAdminNext(browser('/admin-next/api/orders'), env, ctx)).status).toBe(404)
    expect((await handleAdminNext(browser('/admin-next/api/products/1', { method: 'DELETE' }), env, ctx)).status).toBe(404)
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { origin: '' }]) {
      const r = await handleAdminNext(browser('/admin-next/api/logout', { method: 'POST', body: '{}', headers }), env, ctx)
      expect(r.status).toBe(403); expect((await r.json()).error.code).toBe('ORIGIN_NOT_ALLOWED')
    }
    expect((await handleAdminNext(browser('/admin-next/api/logout', { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } }), env, ctx)).status).toBe(415)
    expect((await handleAdminNext(browser('/admin-next/api/products/1', { method: 'PATCH', body: 'x'.repeat(200_001) }), env, ctx)).status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  it('fails closed without configuration or with an unapproved function URL', async () => {
    stubUpstream(json({ data: {} }))
    expect((await handleAdminNext(browser('/admin-next/api/me'), environment({ ADMIN_API_HMAC_SECRET: undefined }), ctx)).status).toBe(503)
    expect((await handleAdminNext(browser('/admin-next/api/me'), environment({ ADMIN_API_HMAC_SECRET: 'short' }), ctx)).status).toBe(503)
    for (const url of ['https://bonxyxluzlxfkdetryoo.supabase.co/functions/v1/admin-api', 'http://uybumsnyqpwcidjxmfsv.supabase.co/functions/v1/admin-api', FN + '/x', 'https://evil.example/functions/v1/admin-api']) {
      expect((await handleAdminNext(browser('/admin-next/api/me'), environment({ ADMIN_API_URL: url }), ctx)).status).toBe(503)
    }
    expect(calls).toHaveLength(0)
  })

  it('signs every forwarded request so the function can verify route, body, ip, origin and session', async () => {
    stubUpstream(json({ data: { ok: true } }))
    const body = JSON.stringify({ expected_version: 1, input: { name: 'A' } })
    const response = await handleAdminNext(browser('/admin-next/api/products/7?x=1&q=%27', { method: 'PATCH', body, headers: { cookie: `dpg-admin-session=${TOKEN}; other=1` } }), environment(), ctx)
    expect(response.status).toBe(200)
    const { url, init } = calls[0]
    expect(url).toBe(`${FN}/products/7?x=1&q=%27`)
    const verified = await verifyEnvelope(SECRET, { method: 'PATCH', route: routeOf(url), body: init.body, headers: new Headers(init.headers) })
    expect(verified).toMatchObject({ ok: true, clientIp: '203.0.113.7', origin: ORIGIN, sessionToken: TOKEN })
    // a GET carries no origin marker and no body
    await handleAdminNext(browser('/admin-next/api/products?limit=5'), environment(), ctx)
    const get = calls[1]; const headers = new Headers(get.init.headers)
    expect(headers.get('x-dpg-origin')).toBe(''); expect(get.init.body).toBeUndefined()
    expect(headers.get('x-dpg-session')).toBeNull()
  })

  it('moves the login token into an HttpOnly SameSite=Strict cookie and never returns it', async () => {
    const expires = new Date(Date.now() + 8 * 3600_000).toISOString()
    stubUpstream(json({ data: { token: TOKEN, expires_at: expires, user: { id: 1, role: 'admin' } } }))
    const r = await handleAdminNext(browser('/admin-next/api/login', { method: 'POST', body: JSON.stringify({ email: 'a@b.co', password: 'x' }) }), environment(), ctx)
    const text = await r.text()
    expect(text).not.toContain(TOKEN); expect(JSON.parse(text).data.user.role).toBe('admin')
    const cookie = r.headers.get('set-cookie')
    expect(cookie).toContain(`dpg-admin-session=${TOKEN}`); expect(cookie).toMatch(/HttpOnly/); expect(cookie).toMatch(/Secure/); expect(cookie).toMatch(/SameSite=Strict/); expect(cookie).toMatch(/Path=\//)
    expect(Number(cookie.match(/Max-Age=(\d+)/)[1])).toBeGreaterThan(8 * 3600 - 60)
    // failed login sets no cookie
    stubUpstream(json({ error: { code: 'INVALID_CREDENTIALS' } }, 401))
    const bad = await handleAdminNext(browser('/admin-next/api/login', { method: 'POST', body: '{}' }), environment(), ctx)
    expect(bad.status).toBe(401); expect(bad.headers.get('set-cookie')).toBeNull()
  })

  it('clears the cookie on logout and on an expired session', async () => {
    stubUpstream(json({ data: { ok: true } }))
    const out = await handleAdminNext(browser('/admin-next/api/logout', { method: 'POST', body: '{}' }), environment(), ctx)
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    stubUpstream(json({ error: { code: 'UNAUTHENTICATED' } }, 401))
    expect((await handleAdminNext(browser('/admin-next/api/me'), environment(), ctx)).headers.get('set-cookie')).toMatch(/Max-Age=0/)
  })

  it('maps upstream failures to generic gateway errors without leaking detail', async () => {
    stubUpstream(() => { throw new Error('connect ECONNREFUSED secret-host') })
    const down = await handleAdminNext(browser('/admin-next/api/me'), environment(), ctx)
    expect(down.status).toBe(502); expect(await down.text()).not.toContain('secret-host')
    stubUpstream(new Response('<html>oops</html>', { status: 500 }))
    expect((await handleAdminNext(browser('/admin-next/api/me'), environment(), ctx)).status).toBe(502)
  })
})
