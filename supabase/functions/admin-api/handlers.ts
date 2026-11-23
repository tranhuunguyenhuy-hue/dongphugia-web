import { getPermissions, type AdminRole } from './permissions.ts'
import { ApiError, type Context, type Db, type Session } from './core.ts'
import * as commerce from './commerce-handlers.ts'
import { createResource, deleteResource, findResource, getResource, listResource, optionsResource, probeExternalColumns, resourceMeta, updateResource } from './resource-handlers.ts'
import { routeOf, sha256Hex, verifyEnvelope, NONCE_TTL_SECONDS } from './envelope.mjs'
import { loginSchema } from './validation.ts'

export type { Db }
export interface Deps {
  db: Db
  hmacSecret: string
  allowedOrigin: string
  allowedMediaHosts?: string
  verifyPassword(plain: string, hash: string): Promise<boolean>
  hashPassword?(plain: string): Promise<string>
  now?: () => number
  sessionHours?: number
}

export const BCRYPT_ROUNDS = 12
// Fixed bcrypt cost-12 hash of a random string: compared when the user does not exist so timing does not reveal accounts.
export const DUMMY_HASH = '$2b$12$YrzAo1leV4oBh05MG3I6w.mfRzPakIhnKnKGI7Hsin8gZtFy1MXkW'
const LOGIN_WINDOW_MINUTES = 15
const MAX_EMAIL_FAILURES = 5
const MAX_IP_FAILURES = 20
const BODY_LIMIT = 600_000

const json = (body: unknown, status: number, request_id: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': request_id, ...headers } })

function route(request: Request) {
  const url = new URL(request.url)
  const full = routeOf(request.url)
  return { path: full.split('?')[0], route: full, search: url.searchParams }
}


async function readBody(request: Request): Promise<string> {
  const text = await request.text()
  if (text.length > BODY_LIMIT) throw new ApiError(413, 'BODY_TOO_LARGE')
  return text
}
const parseJson = (text: string) => { try { return JSON.parse(text) } catch { throw new ApiError(400, 'INVALID_JSON') } }
const validate = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T => {
  const result = schema.safeParse(value)
  if (!result.success) throw new ApiError(400, 'VALIDATION_FAILED')
  return result.data
}

async function loadSession(deps: Deps, token: string): Promise<Session | undefined> {
  if (!/^[0-9a-f]{64}$/.test(token)) return undefined
  const rows = await deps.db.query<{ id: number; user_id: number; email: string; name: string; role: AdminRole; is_active: boolean; expired: boolean }>(
    `select s.id, s.user_id, u.email, u.name, u.role, u.is_active, (s.expires_at <= now()) as expired
       from dpg_app.admin_sessions s join dpg_app.admin_users u on u.id = s.user_id where s.token_hash = $1`,
    [await sha256Hex(token)])
  const row = rows[0]
  if (!row || row.expired || row.is_active === false || !['admin', 'sale_manager', 'sale'].includes(row.role)) return undefined
  return { sessionId: row.id, userId: row.user_id, email: row.email, name: row.name, role: row.role }
}

async function login(deps: Deps, ctx: Context, body: string) {
  const { email, password } = validate(loginSchema, parseJson(body))
  const emailKey = await sha256Hex(`email:${email}`), ipKey = await sha256Hex(`ip:${ctx.ip || 'unknown'}`)
  const counts = await deps.db.query<{ key_hash: string; n: number | string }>(
    `select key_hash, count(*) as n from dpg_app.admin_api_login_attempts
      where key_hash = any($1) and created_at > now() - ($2 || ' minutes')::interval group by key_hash`,
    [[emailKey, ipKey], String(LOGIN_WINDOW_MINUTES)])
  const count = (key: string) => Number(counts.find((row) => row.key_hash === key)?.n ?? 0)
  if (count(emailKey) >= MAX_EMAIL_FAILURES || count(ipKey) >= MAX_IP_FAILURES) throw new ApiError(429, 'RATE_LIMITED')

  const users = await deps.db.query<{ id: number; email: string; name: string; password_hash: string; role: AdminRole; is_active: boolean }>(
    'select id, email, name, password_hash, role, is_active from dpg_app.admin_users where lower(email) = $1', [email])
  const user = users[0]
  const passwordOk = await deps.verifyPassword(password, user?.password_hash ?? DUMMY_HASH)
  if (!user || !passwordOk || user.is_active === false || !['admin', 'sale_manager', 'sale'].includes(user.role)) {
    await deps.db.query('insert into dpg_app.admin_api_login_attempts (key_hash) values ($1), ($2)', [emailKey, ipKey])
    throw new ApiError(401, 'INVALID_CREDENTIALS')
  }
  const tokenBytes = new Uint8Array(32); crypto.getRandomValues(tokenBytes)
  const token = [...tokenBytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  const hours = deps.sessionHours ?? 8
  const expires = await deps.db.transaction(async (tx) => {
    await tx.query('delete from dpg_app.admin_sessions where user_id = $1 and expires_at < now()', [user.id])
    const rows = await tx.query<{ expires_at: string }>(
      `insert into dpg_app.admin_sessions (user_id, token_hash, ip_address, expires_at)
       values ($1, $2, $3, now() + ($4 || ' hours')::interval) returning expires_at`,
      [user.id, await sha256Hex(token), ctx.ip.slice(0, 64) || null, String(hours)])
    await tx.query('update dpg_app.admin_users set last_login_at = now() where id = $1', [user.id])
    await tx.query('delete from dpg_app.admin_api_login_attempts where key_hash = $1', [emailKey])
    return rows[0].expires_at
  })
  return { status: 200, body: { data: { token, expires_at: expires, user: { id: user.id, email: user.email, name: user.name, role: user.role, permissions: getPermissions(user.role) } } } }
}

async function dispatchResource(deps: Deps, ctx: Context, method: string, key: string, tail: string | undefined, search: URLSearchParams, body: string) {
  await probeExternalColumns(deps.db)
  const def = findResource(key)
  const rd = { db: deps.db, allowedMediaHosts: deps.allowedMediaHosts, hashPassword: deps.hashPassword }
  if (tail === 'options') { if (method === 'GET') return optionsResource(rd, ctx, def); throw new ApiError(404, 'NOT_FOUND') }
  if (tail === undefined) {
    if (method === 'GET') return listResource(rd, ctx, def, search)
    if (method === 'POST') return createResource(rd, ctx, def, body)
    throw new ApiError(404, 'NOT_FOUND')
  }
  const id = Number(tail)
  if (method === 'GET') return getResource(rd, ctx, def, id)
  if (method === 'PATCH') return updateResource(rd, ctx, def, id, body)
  if (method === 'DELETE') return deleteResource(rd, ctx, def, id, body)
  throw new ApiError(404, 'NOT_FOUND')
}

type Routed = Promise<{ status: number; body: unknown }> | undefined
/** Orders, quotes, assignees and dashboard (see commerce-handlers.ts). Returns undefined when the path is not one of them. */
function dispatchCommerce(deps: Deps, ctx: Context, method: string, path: string, search: URLSearchParams, body: string): Routed {
  const cd = { db: deps.db }
  if (method === 'GET' && path === '/assignees') return commerce.listAssignees(cd, ctx)
  if (method === 'GET' && path === '/dashboard') return commerce.dashboard(cd, ctx, search)
  if (method === 'POST' && path === '/products/bulk') return commerce.bulkProducts(cd, ctx, body)
  const variants = path.match(/^\/products\/(\d{1,9})\/variants(?:\/(\d{1,9}))?$/)
  if (variants) {
    const pid = Number(variants[1])
    if (variants[2] === undefined) return method === 'GET' ? commerce.listVariants(cd, ctx, pid) : method === 'POST' ? commerce.linkVariant(cd, ctx, pid, body) : undefined
    return method === 'DELETE' ? commerce.unlinkVariant(cd, ctx, pid, Number(variants[2])) : undefined
  }
  const m = path.match(/^\/(orders|quotes)(?:\/(\d{1,9}))?(?:\/(status|payment|assign|complete))?$/)
  if (!m) return undefined
  const [, kind, rawId, action] = m
  const id = rawId === undefined ? undefined : Number(rawId)
  if (kind === 'orders') {
    if (id === undefined) return method === 'GET' ? commerce.listOrders(cd, ctx, search) : undefined
    if (!action) return method === 'GET' ? commerce.getOrder(cd, ctx, id) : method === 'PATCH' ? commerce.editOrder(cd, ctx, id, body) : undefined
    if (method !== 'PATCH') return undefined
    return action === 'status' ? commerce.setOrderStatus(cd, ctx, id, body) : action === 'payment' ? commerce.setPaymentStatus(cd, ctx, id, body) : action === 'assign' ? commerce.assignOrder(cd, ctx, id, body) : undefined
  }
  if (id === undefined) return method === 'GET' ? commerce.listQuotes(cd, ctx, search) : undefined
  if (!action) return method === 'GET' ? commerce.getQuote(cd, ctx, id) : method === 'PATCH' ? commerce.saveQuote(cd, ctx, id, body) : undefined
  if (action === 'complete') return method === 'POST' ? commerce.completeQuote(cd, ctx, id, body) : undefined
  if (method !== 'PATCH') return undefined
  return action === 'status' ? commerce.setQuoteStatus(cd, ctx, id, body) : action === 'assign' ? commerce.assignQuote(cd, ctx, id, body) : undefined
}

async function recordNonce(deps: Deps, nonce: string) {
  const rows = await deps.db.query<{ nonce: string }>(
    `insert into dpg_app.admin_api_nonces (nonce, expires_at) values ($1, now() + ($2 || ' seconds')::interval)
     on conflict (nonce) do nothing returning nonce`, [nonce, String(NONCE_TTL_SECONDS)])
  if (!rows[0]) throw new ApiError(401, 'REPLAYED_REQUEST')
  if (Math.random() < 0.05) await deps.db.query('delete from dpg_app.admin_api_nonces where expires_at < now()').catch(() => undefined)
}

export async function handleRequest(request: Request, deps: Deps): Promise<Response> {
  const request_id = crypto.randomUUID()
  try {
    if (request.method === 'OPTIONS') return json({ error: { code: 'NOT_FOUND', request_id } }, 404, request_id)
    const { path, route: routeWithSearch, search } = route(request)
    const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await readBody(request)
    const verified = await verifyEnvelope(deps.hmacSecret, { method: request.method, route: routeWithSearch, body, headers: request.headers, now: deps.now?.() })
    if (!verified.ok) throw new ApiError(401, verified.code ?? 'INVALID_SIGNATURE')
    // Mutations must carry the gateway-verified same-origin marker (CSRF defence in depth).
    if (request.method !== 'GET' && request.method !== 'HEAD' && (!deps.allowedOrigin || verified.origin !== deps.allowedOrigin)) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED')
    const ctx: Context = { request_id, ip: verified.clientIp }
    // Replay check and session lookup are independent: issue them together so the driver pipelines both in one round trip.
    const [, session] = await Promise.all([
      recordNonce(deps, verified.nonce),
      verified.sessionToken ? loadSession(deps, verified.sessionToken) : Promise.resolve(undefined),
    ])
    ctx.session = session

    let result: { status: number; body: unknown }
    if (request.method === 'POST' && path === '/login') result = await login(deps, ctx, body)
    else if (request.method === 'POST' && path === '/logout') {
      if (ctx.session) await deps.db.query('delete from dpg_app.admin_sessions where id = $1', [ctx.session.sessionId])
      result = { status: 200, body: { data: { ok: true } } }
    } else if (request.method === 'GET' && path === '/me') {
      if (!ctx.session) throw new ApiError(401, 'UNAUTHENTICATED')
      result = { status: 200, body: { data: { id: ctx.session.userId, email: ctx.session.email, name: ctx.session.name, role: ctx.session.role, permissions: getPermissions(ctx.session.role) } } }
    } else if (request.method === 'GET' && path === '/schema') {
      if (!ctx.session) throw new ApiError(401, 'UNAUTHENTICATED')
      await probeExternalColumns(deps.db)
      result = { status: 200, body: { data: { resources: resourceMeta(ctx.session.role) } } }
    } else {
      const generic = path.match(/^\/r\/([a-z][a-z0-9-]{1,40})(?:\/(options|\d{1,9}))?$/)
      if (generic) result = await dispatchResource(deps, ctx, request.method, generic[1], generic[2], search, body)
      else {
        const routed = dispatchCommerce(deps, ctx, request.method, path, search, body)
        if (!routed) throw new ApiError(404, 'NOT_FOUND')
        result = await routed
      }
    }
    return json(result.body, result.status, request_id)
  } catch (error) {
    if (error instanceof ApiError) return json({ error: { code: error.code, request_id, ...(error.fields?.length ? { fields: error.fields } : {}) } }, error.status, request_id)
    console.error(JSON.stringify({ event: 'ADMIN_API_ERROR', request_id, name: error instanceof Error ? error.name : 'unknown', sqlstate: (error as { code?: unknown })?.code ?? null, detail: error instanceof Error ? error.message.slice(0, 160) : '' }))
    return json({ error: { code: 'INTERNAL', request_id } }, 500, request_id)
  }
}
