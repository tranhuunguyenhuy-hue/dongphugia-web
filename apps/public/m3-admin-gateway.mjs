// Same-origin gateway for the static Admin shell (M3 G4 pilot). Runs inside the combined staging Worker:
// it does NO rendering and NO database access; it validates the browser request, signs it and forwards it to the
// Supabase Edge Function `admin-api` (TEST project only). Source is concatenated into worker.mjs by the builder, so
// this file may only import ./m3-admin-envelope.mjs (a byte-identical copy of the function's envelope, enforced by a test).
import { routeOf, signEnvelope } from './m3-admin-envelope.mjs' // inline-import

export const ADMIN_NEXT_BASE = '/admin-next'
const API_PREFIX = `${ADMIN_NEXT_BASE}/api`
const SESSION_COOKIE = 'dpg-admin-session'
const APPROVED_FUNCTION_URL = /^https:\/\/uybumsnyqpwcidjxmfsv\.supabase\.co\/functions\/v1\/admin-api$/
const ROUTES = [
  { method: 'POST', pattern: /^\/login$/ }, { method: 'POST', pattern: /^\/logout$/ }, { method: 'GET', pattern: /^\/me$/ },
  { method: 'GET', pattern: /^\/products$/ }, { method: 'GET', pattern: /^\/products\/\d{1,9}$/ }, { method: 'PATCH', pattern: /^\/products\/\d{1,9}$/ },
  // Generic resources (blog, banners, ...): the function owns the resource registry and RBAC; the gateway only checks shape.
  { method: 'GET', pattern: /^\/schema$/ },
  { method: 'GET', pattern: /^\/r\/[a-z][a-z0-9-]{1,40}$/ }, { method: 'POST', pattern: /^\/r\/[a-z][a-z0-9-]{1,40}$/ },
  { method: 'GET', pattern: /^\/r\/[a-z][a-z0-9-]{1,40}\/options$/ },
  { method: 'GET', pattern: /^\/r\/[a-z][a-z0-9-]{1,40}\/\d{1,9}$/ }, { method: 'PATCH', pattern: /^\/r\/[a-z][a-z0-9-]{1,40}\/\d{1,9}$/ },
  { method: 'DELETE', pattern: /^\/r\/[a-z][a-z0-9-]{1,40}\/\d{1,9}$/ },
]
const MAX_BODY_BYTES = 600_000
const UPSTREAM_TIMEOUT_MS = 8_000
// The TEST project database lives in Singapore: run the Edge Function next to it instead of next to the caller.
const ADMIN_API_REGION = 'ap-southeast-1'

export function isAdminNextPath(pathname) {
  return pathname === ADMIN_NEXT_BASE || pathname.startsWith(`${ADMIN_NEXT_BASE}/`)
}

const baseHeaders = (sourceSha) => ({
  'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow',
  ...(sourceSha ? { 'x-dpg-source-sha': sourceSha } : {}),
})
const jsonError = (status, code, sourceSha, extra = {}) =>
  new Response(JSON.stringify({ error: { code } }), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...baseHeaders(sourceSha), ...extra } })

function readCookie(request, name) {
  const header = request.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return ''
}
const sessionCookie = (token, expiresAt) => {
  const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000))
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
}
const clearedCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`

/** True only for a browser request that provably originates from this Worker's own pages. */
function isSameOriginMutation(request, stagingOrigin) {
  if (request.headers.get('origin') !== stagingOrigin) return false
  const site = request.headers.get('sec-fetch-site')
  return site === null || site === 'same-origin'
}

export async function handleAdminNext(request, environment, { sourceSha, stagingOrigin }) {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(`${API_PREFIX}/`)) {
    // Static shell: real files are served by the assets binding before the Worker runs; this is the SPA fallback.
    if (request.method !== 'GET' && request.method !== 'HEAD') return jsonError(405, 'METHOD_NOT_ALLOWED', sourceSha, { allow: 'GET, HEAD' })
    if (/\.[a-z0-9]{1,8}$/i.test(url.pathname)) return jsonError(404, 'NOT_FOUND', sourceSha)
    const shell = await environment.ASSETS.fetch(new Request(new URL(`${ADMIN_NEXT_BASE}/`, url.origin), { method: 'GET' }))
    if (!shell.ok) return jsonError(404, 'NOT_FOUND', sourceSha)
    const headers = new Headers(shell.headers)
    for (const [name, value] of Object.entries(baseHeaders(sourceSha))) headers.set(name, value)
    return new Response(shell.body, { status: 200, headers })
  }

  const route = url.pathname.slice(API_PREFIX.length) + url.search
  const path = url.pathname.slice(API_PREFIX.length)
  if (!ROUTES.some((entry) => entry.method === request.method && entry.pattern.test(path))) return jsonError(404, 'NOT_FOUND', sourceSha)
  const mutation = request.method !== 'GET'
  if (mutation && !isSameOriginMutation(request, stagingOrigin)) return jsonError(403, 'ORIGIN_NOT_ALLOWED', sourceSha)
  const functionUrl = environment.ADMIN_API_URL, secret = environment.ADMIN_API_HMAC_SECRET
  if (typeof functionUrl !== 'string' || !APPROVED_FUNCTION_URL.test(functionUrl) || typeof secret !== 'string' || secret.length < 32) {
    return jsonError(503, 'ADMIN_API_NOT_CONFIGURED', sourceSha)
  }

  let body = ''
  if (mutation) {
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return jsonError(415, 'UNSUPPORTED_MEDIA_TYPE', sourceSha)
    body = await request.text()
    if (body.length > MAX_BODY_BYTES) return jsonError(413, 'BODY_TOO_LARGE', sourceSha)
  }
  const target = `${functionUrl}${route}`
  const sessionToken = readCookie(request, SESSION_COOKIE)
  const headers = await signEnvelope(secret, {
    method: request.method, route: routeOf(target), body,
    clientIp: request.headers.get('cf-connecting-ip') ?? '', origin: mutation ? stagingOrigin : '',
    sessionToken: /^[0-9a-f]{64}$/.test(sessionToken) ? sessionToken : undefined,
  })
  let upstream
  try {
    upstream = await fetch(target, {
      method: request.method, headers: { ...headers, 'x-region': ADMIN_API_REGION, ...(mutation ? { 'content-type': 'application/json' } : {}) },
      body: mutation ? body : undefined, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), redirect: 'manual',
    })
  } catch {
    return jsonError(502, 'UPSTREAM_UNAVAILABLE', sourceSha)
  }
  const text = await upstream.text()
  let payload
  try { payload = JSON.parse(text) } catch { return jsonError(502, 'UPSTREAM_INVALID', sourceSha) }
  // Only the admin-api contract is relayed ({data} or {error:{code}}); anything else (platform errors such as a
  // missing function) is replaced by a generic code so no provider message or detail reaches the browser.
  const conforming = payload !== null && typeof payload === 'object'
    && (('data' in payload) || (typeof payload.error?.code === 'string' && /^[A-Z_]{3,40}$/.test(payload.error.code)))
  if (!conforming) return jsonError(502, 'UPSTREAM_INVALID', sourceSha)
  const extra = {}
  if (path === '/login' && upstream.status === 200 && typeof payload?.data?.token === 'string') {
    extra['set-cookie'] = sessionCookie(payload.data.token, payload.data.expires_at)
    delete payload.data.token // the session token only ever travels in the HttpOnly cookie
  } else if (path === '/logout' || (upstream.status === 401 && path === '/me')) {
    extra['set-cookie'] = clearedCookie
  }
  return new Response(JSON.stringify(payload), {
    status: upstream.status, headers: { 'content-type': 'application/json; charset=utf-8', ...baseHeaders(sourceSha), ...extra },
  })
}
