// Commerce v1 inbox: guest ORDERS and QUOTE REQUESTS stored in the NEW schema `dpg_commerce` (supabase/commerce-v1/001_commerce_schema.sql).
// Replaces the legacy order/quote handlers (dpg_app.orders/quote_requests are never read or written here). Staff can: list, read the exact snapshot the customer
// submitted, move the status new -> processing -> done (or cancel), write an internal note, and assign a record. They can NOT edit totals, lines or customer data
// (the database grants only status/note/assignment/version), and they never mark anything "paid": payment, delivery and cost are confirmed with the customer outside the system.
// Same rules as the resource engine: parameterised SQL only, RBAC on every operation (roles without the "read all" permission see only records assigned to them),
// optimistic version check, audit row + event in the same transaction.
import { z } from 'zod'
import { ApiError, mapDatabaseError, requirePermission, type Context, type Db, type Session } from './core.ts'
import { can, type Permission } from './permissions.ts'
import { audit, parseJson, pick, validate } from './resource-handlers.ts'

type Deps = { db: Db }
type Result = { status: number; body: unknown }
type Row = Record<string, unknown>
export type SalesKind = 'orders' | 'quotes'
const STATUSES = ['new', 'processing', 'done', 'cancelled'] as const
const TABLE: Record<SalesKind, { table: string; lines: string; fk: string; entity: 'order' | 'quote'; read: Permission[]; readAll: Permission; status: Permission; cancel: Permission; assign: Permission; note: Permission }> = {
  orders: { table: 'dpg_commerce.orders', lines: 'dpg_commerce.order_lines', fk: 'order_id', entity: 'order', read: ['orders:read', 'orders:read_assigned'], readAll: 'orders:read', status: 'orders:update_status', cancel: 'orders:cancel', assign: 'orders:assign', note: 'orders:edit_note' },
  quotes: { table: 'dpg_commerce.quotes', lines: 'dpg_commerce.quote_lines', fk: 'quote_id', entity: 'quote', read: ['quotes:read', 'quotes:read_assigned'], readAll: 'quotes:read', status: 'quotes:update', cancel: 'quotes:update', assign: 'orders:assign', note: 'quotes:update' },
}
const COMMON = 'id, code, status, customer_name, customer_phone, customer_email, note, staff_note, assigned_to, version, line_count, created_at, updated_at'
const COLUMNS: Record<SalesKind, string> = { orders: `${COMMON}, delivery_address, subtotal_vnd, voucher_vnd, total_vnd`, quotes: COMMON }
const LIST_COLUMNS: Record<SalesKind, string> = {
  orders: 'id, code, status, customer_name, customer_phone, total_vnd, line_count, assigned_to, created_at, updated_at',
  quotes: 'id, code, status, customer_name, customer_phone, line_count, assigned_to, created_at, updated_at',
}
const ASSIGNABLE_ROLES = ['admin', 'sale_manager', 'sale']
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value))
/** Until the commerce schema exists (separate Owner GO) every inbox route answers 503 COMMERCE_NOT_READY instead of a 500. */
const SCHEMA_MISSING = new Set(['42P01', '3F000', '42501'])
const ready = async <T>(work: () => Promise<T>): Promise<T> => { try { return await work() } catch (error) { if (SCHEMA_MISSING.has((error as { code?: string })?.code ?? '')) throw new ApiError(503, 'COMMERCE_NOT_READY'); throw error } }
const idOf = (value: number) => { if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new ApiError(404, 'NOT_FOUND'); return value }
const pageQuery = { page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(50).default(25) }

function requireAny(ctx: Context, permissions: Permission[]): Session {
  if (!ctx.session) throw new ApiError(401, 'UNAUTHENTICATED')
  if (!permissions.some((permission) => can(ctx.session!.role, permission))) throw new ApiError(403, 'FORBIDDEN')
  return ctx.session
}
const money = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, /_vnd$/.test(k) ? num(v) : v]))

async function load(db: Db, ctx: Context, kind: SalesKind, id: number, lock = false): Promise<Row> {
  const cfg = TABLE[kind], session = ctx.session!
  const row = (await db.query<Row>(`select ${COLUMNS[kind]} from ${cfg.table} where id = $1${lock ? ' for update' : ''}`, [id]))[0]
  if (!row || (!can(session.role, cfg.readAll) && row.assigned_to !== session.userId)) throw new ApiError(404, 'NOT_FOUND')   // not assigned to you = looks absent
  return row
}

/** Search/list is a POST with a JSON body (never a URL): a customer phone typed by staff must not appear in browser history, gateway or Edge access logs. */
export async function listSales(deps: Deps, ctx: Context, kind: SalesKind, body: string): Promise<Result> {
  const cfg = TABLE[kind], session = requireAny(ctx, cfg.read)
  const query = validate(z.object({ q: z.string().trim().max(100).optional(), status: z.enum(STATUSES).optional(), ...pageQuery }).strict(), parseJson(body))
  const where: string[] = [], params: unknown[] = []
  if (!can(session.role, cfg.readAll)) { params.push(session.userId); where.push(`assigned_to = $${params.length}`) }
  const scopeParams = [...params], scope = where.join(' and ')
  if (query.status) { params.push(query.status); where.push(`status = $${params.length}`) }
  if (query.q) { params.push(`%${escapeLike(query.q)}%`); where.push(`(code ilike $${params.length} escape '\\' or customer_name ilike $${params.length} escape '\\' or customer_phone like $${params.length} escape '\\')`) }
  const filter = where.length ? `where ${where.join(' and ')}` : ''
  const listParams = [...params, query.limit, (query.page - 1) * query.limit]
  const [rows, total, counts] = await ready(() => Promise.all([
    deps.db.query<Row>(`select ${LIST_COLUMNS[kind]} from ${cfg.table} ${filter} order by created_at desc, id desc limit $${params.length + 1} offset $${params.length + 2}`, listParams),
    deps.db.query<{ n: string }>(`select count(*) as n from ${cfg.table} ${filter}`, params),
    deps.db.query<{ status: string; n: string }>(`select status, count(*) as n from ${cfg.table} ${scope ? `where ${scope}` : ''} group by status`, scopeParams),
  ]))
  return { status: 200, body: { data: { items: rows.map(money), total: Number(total[0].n), page: query.page, limit: query.limit, counts: Object.fromEntries(STATUSES.map((s) => [s, Number(counts.find((c) => c.status === s)?.n ?? 0)])) } } }
}

export async function getSales(deps: Deps, ctx: Context, kind: SalesKind, id: number): Promise<Result> {
  const cfg = TABLE[kind]; requireAny(ctx, cfg.read)
  const row = await ready(() => load(deps.db, ctx, kind, idOf(id)))
  const linesSql = kind === 'orders'
    ? `select line_no, product_id, sku, product_name, brand, quantity, regular_vnd, unit_selling_vnd, unit_voucher_vnd, line_subtotal_vnd, line_voucher_vnd from ${cfg.lines} where ${cfg.fk} = $1 order by line_no`
    : `select line_no, product_id, sku, product_name, brand, quantity, reason, unit_selling_vnd from ${cfg.lines} where ${cfg.fk} = $1 order by line_no`
  const [lines, events, assignee] = await Promise.all([
    deps.db.query<Row>(linesSql, [id]),
    deps.db.query<Row>('select actor, action, from_status, to_status, at from dpg_commerce.events where entity = $1 and entity_id = $2 order by id', [cfg.entity, id]),
    row.assigned_to ? deps.db.query<Row>('select name from dpg_app.admin_users where id = $1', [row.assigned_to]) : Promise.resolve([]),
  ])
  const numbered = lines.map((l) => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, /_vnd$/.test(k) ? num(v) : v])))
  return { status: 200, body: { data: { ...money(row), assigned_name: assignee[0]?.name ?? null, lines: numbered, events } } }
}

async function write(deps: Deps, ctx: Context, kind: SalesKind, id: number, permission: (before: Row) => Permission, action: 'status' | 'note' | 'assign', expectedVersion: number,
  apply: (tx: Db, before: Row) => Promise<{ set: string; params: unknown[]; changed: string[]; from?: string | null; to?: string | null }>): Promise<Result> {
  if (!ctx.session) throw new ApiError(401, 'UNAUTHENTICATED')
  const cfg = TABLE[kind]
  try {
    const out = await deps.db.transaction(async (tx) => {
      const before = await load(tx, ctx, kind, idOf(id), true)
      requirePermission(ctx, permission(before))
      if (Number(before.version) !== expectedVersion) throw new ApiError(409, 'VERSION_CONFLICT')
      const change = await apply(tx, before)
      const updated = await tx.query(`update ${cfg.table} set ${change.set}, version = version + 1 where id = $1 and version = $${change.params.length + 2} returning id`, [id, ...change.params, expectedVersion])
      if (!updated[0]) throw new ApiError(409, 'VERSION_CONFLICT')
      const after = await load(tx, ctx, kind, id)
      await tx.query('insert into dpg_commerce.events (entity, entity_id, actor, action, from_status, to_status) values ($1, $2, $3, $4, $5, $6)',
        [cfg.entity, id, `admin:${ctx.session!.userId}`, action, change.from ?? null, change.to ?? null])
      await audit(tx, ctx, `commerce_${kind}`, action, id, pick(before, change.changed), pick(after, change.changed), change.changed)
      return after
    })
    return { status: 200, body: { data: money(out) } }
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof Error && error.message.startsWith('COMMERCE_STATUS_TRANSITION_INVALID')) throw new ApiError(409, 'STATUS_TRANSITION_INVALID')
    throw mapDatabaseError(error) ?? error
  }
}

const versioned = { expected_version: z.number().int().min(1).max(2_147_483_647) }
export const setSalesStatus = async (deps: Deps, ctx: Context, kind: SalesKind, id: number, body: string) => {
  const input = validate(z.object({ status: z.enum(STATUSES).exclude(['new']), note: z.string().trim().max(2000).optional(), ...versioned }).strict(), parseJson(body))
  const cfg = TABLE[kind]
  return write(deps, ctx, kind, id, () => (input.status === 'cancelled' ? cfg.cancel : cfg.status), 'status', input.expected_version, async (tx, before) => {
    // "new" is never a target; the database trigger also refuses every other jump (new->done, done->anything, ...)
    const note = input.note === undefined ? '' : ', staff_note = $3'
    void tx
    return { set: `status = $2${note}`, params: input.note === undefined ? [input.status] : [input.status, input.note], changed: ['status', ...(input.note === undefined ? [] : ['staff_note'])], from: String(before.status), to: input.status }
  })
}
export const setSalesNote = async (deps: Deps, ctx: Context, kind: SalesKind, id: number, body: string) => {
  const input = validate(z.object({ note: z.string().trim().max(2000).nullable(), ...versioned }).strict(), parseJson(body))
  return write(deps, ctx, kind, id, () => TABLE[kind].note, 'note', input.expected_version, async () => ({ set: 'staff_note = $2', params: [input.note === '' ? null : input.note], changed: ['staff_note'] }))
}
export const assignSales = async (deps: Deps, ctx: Context, kind: SalesKind, id: number, body: string) => {
  const input = validate(z.object({ user_id: z.number().int().min(1).max(2_147_483_647).nullable(), ...versioned }).strict(), parseJson(body))
  return write(deps, ctx, kind, id, () => TABLE[kind].assign, 'assign', input.expected_version, async (tx) => {
    if (input.user_id !== null && !(await tx.query('select id from dpg_app.admin_users where id = $1 and is_active = true and role = any($2)', [input.user_id, ASSIGNABLE_ROLES]))[0]) throw new ApiError(400, 'VALIDATION_FAILED', ['user_id'])
    return { set: 'assigned_to = $2::int', params: [input.user_id], changed: ['assigned_to'] }
  })
}

/** Counts of NEW records for the dashboard badge (assigned-only roles see only their own). */
export async function salesSummary(deps: Deps, ctx: Context): Promise<Result> {
  const session = requireAny(ctx, ['orders:read', 'orders:read_assigned', 'quotes:read', 'quotes:read_assigned'])
  const scoped = (kind: SalesKind) => (can(session.role, TABLE[kind].readAll) ? '' : 'and assigned_to = $1')
  const one = (kind: SalesKind) => (can(session.role, TABLE[kind].readAll) || can(session.role, TABLE[kind].read[1])
    ? deps.db.query<{ n: string }>(`select count(*) as n from ${TABLE[kind].table} where status = 'new' ${scoped(kind)}`, can(session.role, TABLE[kind].readAll) ? [] : [session.userId]) : Promise.resolve([{ n: '0' }]))
  const [orders, quotes] = await ready(() => Promise.all([one('orders'), one('quotes')]))
  return { status: 200, body: { data: { new_orders: Number(orders[0].n), new_quotes: Number(quotes[0].n) } } }
}
