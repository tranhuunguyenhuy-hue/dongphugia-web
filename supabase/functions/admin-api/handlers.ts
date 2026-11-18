import { getPermissions, type AdminRole, type Permission } from './permissions.ts'
import { ApiError, requirePermission as requirePerm, type Context, type Db, type Session } from './core.ts'
import * as commerce from './commerce-handlers.ts'
import { audit, createResource, deleteResource, findResource, getResource, listResource, optionsResource, resourceMeta, updateResource } from './resource-handlers.ts'
import { routeOf, sha256Hex, verifyEnvelope, NONCE_TTL_SECONDS } from './envelope.mjs'
import { listQuerySchema, loginSchema, parseAllowedMediaHosts, productPatchSchema, VISIBILITY_FIELDS } from './validation.ts'

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

const requirePermission = (ctx: Context, permission: Permission) => { requirePerm(ctx, permission) }

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
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

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

const PRODUCT_COLUMNS = `p.id, p.sku, p.name, p.display_name, p.slug, p.category_id, p.subcategory_id, p.brand_id, p.price, p.price_display,
  p.description, p.image_main_url, p.is_active, p.is_featured, p.publication_status, p.pdp_visibility, p.listing_visibility,
  p.seo_title, p.seo_description, p.updated_at, p.version`

async function listProducts(deps: Deps, ctx: Context, search: URLSearchParams) {
  requirePermission(ctx, 'products:read')
  const query = validate(listQuerySchema, Object.fromEntries(search))
  const like = query.q ? `%${escapeLike(query.q)}%` : null
  const rows = await deps.db.query<Record<string, unknown>>(
    `select p.id, p.sku, p.name, p.slug, p.is_active, p.publication_status, p.pdp_visibility, p.image_main_url, p.version, p.updated_at,
            count(*) over() as total
       from dpg_app.products p
      where ($1::text is null or p.name ilike $1 escape '\\' or p.sku ilike $1 escape '\\')
      order by p.id desc limit $2 offset $3`,
    [like, query.limit, (query.page - 1) * query.limit])
  const total = Number(rows[0]?.total ?? 0)
  return { status: 200, body: { data: { items: rows.map(({ total: _t, ...row }) => row), total, page: query.page, limit: query.limit } } }
}

async function getProduct(deps: Deps, ctx: Context, id: number) {
  requirePermission(ctx, 'products:read')
  const rows = await deps.db.query(
    `select ${PRODUCT_COLUMNS}, c.name as category_name, s.name as subcategory_name, b.name as brand_name
       from dpg_app.products p join dpg_app.categories c on c.id = p.category_id
       left join dpg_app.subcategories s on s.id = p.subcategory_id left join dpg_app.brands b on b.id = p.brand_id
      where p.id = $1`, [id])
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND')
  return { status: 200, body: { data: rows[0] } }
}

async function patchProduct(deps: Deps, ctx: Context, id: number, body: string) {
  requirePermission(ctx, 'products:write')
  const { input, expected_version } = validate(productPatchSchema(parseAllowedMediaHosts(deps.allowedMediaHosts)), parseJson(body))
  if (VISIBILITY_FIELDS.some((field) => field in input)) requirePermission(ctx, 'visibility:write')
  const fields = Object.keys(input) as (keyof typeof input)[]
  const changed = await deps.db.transaction(async (tx) => {
    const before = (await tx.query<Record<string, unknown>>(`select ${PRODUCT_COLUMNS} from dpg_app.products p where p.id = $1 for update of p`, [id]))[0]
    if (!before) throw new ApiError(404, 'NOT_FOUND')
    if (expected_version !== undefined && Number(before.version) !== expected_version) throw new ApiError(409, 'VERSION_CONFLICT')
    const sets = fields.map((field, index) => `${field} = $${index + 2}`)
    const after = (await tx.query<Record<string, unknown>>(
      `update dpg_app.products set ${sets.join(', ')}, version = coalesce(version, 0) + 1, updated_at = now()
        where id = $1 returning ${PRODUCT_COLUMNS.replace(/p\./g, '')}`,
      [id, ...fields.map((field) => input[field] ?? null)]))[0]
    const oldValue: Record<string, unknown> = {}, newValue: Record<string, unknown> = {}
    for (const field of fields) { oldValue[field] = before[field]; newValue[field] = after[field] }
    await audit(tx, ctx, 'product', 'update', id, oldValue, newValue, fields as string[])
    return after
  })
  return { status: 200, body: { data: changed } }
}

async function dispatchResource(deps: Deps, ctx: Context, method: string, key: string, tail: string | undefined, search: URLSearchParams, body: string) {
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
      result = { status: 200, body: { data: { resources: resourceMeta(ctx.session.role) } } }
    } else if (request.method === 'GET' && path === '/products') result = await listProducts(deps, ctx, search)
    else {
      const match = path.match(/^\/products\/(\d{1,9})$/)
      const generic = path.match(/^\/r\/([a-z][a-z0-9-]{1,40})(?:\/(options|\d{1,9}))?$/)
      if (match && request.method === 'GET') result = await getProduct(deps, ctx, Number(match[1]))
      else if (match && request.method === 'PATCH') result = await patchProduct(deps, ctx, Number(match[1]), body)
      else if (generic) result = await dispatchResource(deps, ctx, request.method, generic[1], generic[2], search, body)
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
