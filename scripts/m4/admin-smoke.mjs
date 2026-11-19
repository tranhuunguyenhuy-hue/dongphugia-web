// Unauthenticated Production Admin smoke (no credentials, no data written). Usage: node admin-smoke.mjs <baseUrl> <configured|unconfigured> <sourceSha|->
//   configured   : the Worker holds the Admin secrets -> the signed call reaches the function, which must answer UNAUTHENTICATED
//                  (that single check proves the Worker's and the function's HMAC secrets are the same value)
//   unconfigured : a pre-publish packaged run without secrets -> the gateway must fail closed with ADMIN_API_NOT_CONFIGURED
import assert from 'node:assert/strict'

const [baseArgument, mode, sourceSha] = process.argv.slice(2)
assert.ok(['configured', 'unconfigured'].includes(mode), 'M4_SMOKE_MODE')
const base = new URL(baseArgument)
const origin = 'https://www.dongphugia.vn'
const checks = []
const record = (name, ok, detail = '') => { checks.push({ name, ok }); console.log(`M4_ADMIN_SMOKE ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`) }
const call = (path, init = {}) => fetch(new URL(path, base), { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(20_000), ...init, headers: { 'user-agent': 'dpg-m4-smoke', ...(init.headers ?? {}) } })
const expect = async (name, path, init, predicate) => {
  try { const response = await call(path, init); const text = await response.text(); const ok = await predicate(response, text); record(name, Boolean(ok), `status=${response.status}`) } catch (error) { record(name, false, `error=${error?.name ?? 'unknown'}`) }
}
const code = (text) => { try { return JSON.parse(text)?.error?.code } catch { return undefined } }
const sameOrigin = { origin, 'sec-fetch-site': 'same-origin' }

await expect('admin shell is noindex and uncached', '/admin-next/', {}, (r, t) => r.status === 200 && /noindex/.test(r.headers.get('x-robots-tag') ?? '') && /no-store/.test(r.headers.get('cache-control') ?? '') && /<div id="root"|<title>/i.test(t))
await expect('SPA deep link falls back to the shell', '/admin-next/products/1', {}, (r) => r.status === 200 && /noindex/.test(r.headers.get('x-robots-tag') ?? ''))
for (const path of ['/admin', '/admin/login', '/admin/products']) {
  await expect(`legacy ${path} redirects to the new Admin`, path, {}, (r) => r.status === 302 && r.headers.get('location') === '/admin-next/')
}
await expect('legacy Admin never accepts writes', '/admin/anything', { method: 'POST' }, (r) => r.status === 404)
await expect('anonymous /me is rejected', '/admin-next/api/me', {}, (r, t) => mode === 'configured' ? r.status === 401 && code(t) === 'UNAUTHENTICATED' : r.status === 503 && code(t) === 'ADMIN_API_NOT_CONFIGURED')
await expect('Dev-managed master data cannot be written', '/admin-next/api/r/brands', { method: 'POST', headers: { ...sameOrigin, 'content-type': 'application/json' }, body: '{}' }, (r, t) => r.status === 403 && code(t) === 'DEV_MANAGED')
await expect('cross-origin mutation is refused', '/admin-next/api/r/blog-posts', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' }, (r, t) => r.status === 403 && code(t) === 'ORIGIN_NOT_ALLOWED')
await expect('unknown API route is a 404', '/admin-next/api/nope', {}, (r) => r.status === 404)
await expect('upload rejects GET', '/api/upload-image', {}, (r) => r.status === 405)
await expect('anonymous upload is rejected before any body work', '/api/upload-image', { method: 'POST', headers: { ...sameOrigin, 'content-type': 'multipart/form-data; boundary=x', 'content-length': '10' }, body: '--x--\r\n\r\n' }, (r) => mode === 'configured' ? r.status === 401 : r.status === 503)
await expect('Public home is unchanged (200, indexable, no Admin cookie)', '/', {}, (r) => r.status === 200 && !/noindex/.test(r.headers.get('x-robots-tag') ?? '') && !/dpg-admin-session/.test(r.headers.get('set-cookie') ?? '') && (sourceSha === '-' || !sourceSha || r.headers.get('x-dpg-source-sha') === sourceSha))
await expect('Public health reports PostgreSQL', '/api/health', {}, (r, t) => r.status === 200 && /postgresql/.test(t))

const failed = checks.filter((c) => !c.ok)
console.log(`M4_ADMIN_SMOKE ${failed.length ? 'FAIL' : 'PASS'} mode=${mode} checks=${checks.length} failed=${failed.length}`)
process.exit(failed.length ? 1 : 0)
