// Orders, quote requests, assignees and the dashboard (M3 G4). These flows are not plain CRUD (totals, status
// workflow, customer sync) so they have dedicated handlers, but follow the same rules as the resource engine:
// parameterised SQL only, RBAC on every operation, assigned-only visibility for roles without the "read all"
// permission, audit rows in the same transaction. Totals are always recomputed on the server from stored lines.
import { z } from 'zod'
import { ApiError, mapDatabaseError, requirePermission, type Context, type Db, type Session } from './core.ts'
import { can, type Permission } from './permissions.ts'
import { audit, parseJson, pick, validate } from './resource-handlers.ts'

type Deps = { db: Db }
type Result = { status: number; body: unknown }
type Row = Record<string, unknown>

const ORDER_STATUSES = ['pending', 'received', 'confirmed', 'inventory_check', 'completed', 'cancelled'] as const
const PAYMENT_STATUSES = ['unpaid', 'paid', 'refunded'] as const
const QUOTE_STATUSES = ['pending', 'resolved', 'completed', 'cancelled'] as const
const ASSIGNABLE_ROLES = ['admin', 'sale_manager', 'sale']
const MONEY_MAX = 99_999_999_999
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value))
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

const pageQuery = {
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(25),
}
const idOf = (value: number) => { if (!Number.isInteger(value) || value < 1) throw new ApiError(404, 'NOT_FOUND'); return value }

function requireAny(ctx: Context, permissions: Permission[]): Session {
  if (!ctx.session) throw new ApiError(401, 'UNAUTHENTICATED')
  const role = ctx.session.role
  if (!permissions.some((permission) => can(role, permission))) throw new ApiError(403, 'FORBIDDEN')
  return ctx.session
}

/** Active staff a record can be assigned to (shown to roles that may assign). */
export async function listAssignees(deps: Deps, ctx: Context): Promise<Result> {
  requireAny(ctx, ['orders:assign', 'quotes:update'])
  const rows = await deps.db.query('select id, name, role from dpg_app.admin_users where is_active = true and role = any($1) order by name asc, id asc', [ASSIGNABLE_ROLES])
  return { status: 200, body: { data: { items: rows } } }
}

async function assertAssignee(db: Db, userId: number | null) {
  if (userId === null) return
  const rows = await db.query('select id from dpg_app.admin_users where id = $1 and is_active = true and role = any($2)', [userId, ASSIGNABLE_ROLES])
  if (!rows[0]) throw new ApiError(400, 'VALIDATION_FAILED', ['user_id'])
}

// ---------------------------------------------------------------------------------------------------- orders
const ORDER_COLUMNS = `o.id, o.order_number, o.customer_name, o.customer_phone, o.customer_email, o.customer_address, o.note, o.subtotal,
  o.shipping_fee, o.discount, o.vat_rate, o.total, o.status, o.payment_method, o.payment_status, o.created_at, o.updated_at, o.assigned_to, o.assigned_at`

const orderMoney = (row: Row): Row => ({ ...row, subtotal: num(row.subtotal), shipping_fee: num(row.shipping_fee), discount: num(row.discount), total: num(row.total) })

/** Roles without `orders:read` only ever see (and may act on) orders assigned to them; others look like 404. */
async function loadOrder(db: Db, ctx: Context, id: number, lock = false): Promise<Row> {
  const session = ctx.session!
  const row = (await db.query<Row>(`select ${ORDER_COLUMNS} from dpg_app.orders o where o.id = $1${lock ? ' for update of o' : ''}`, [id]))[0]
  if (!row || (!can(session.role, 'orders:read') && row.assigned_to !== session.userId)) throw new ApiError(404, 'NOT_FOUND')
  return row
}

export async function listOrders(deps: Deps, ctx: Context, search: URLSearchParams): Promise<Result> {
  const session = requireAny(ctx, ['orders:read', 'orders:read_assigned'])
  const query = validate(z.object({
    q: z.string().trim().max(100).optional(), status: z.enum(ORDER_STATUSES).optional(), payment_status: z.enum(PAYMENT_STATUSES).optional(), ...pageQuery,
  }).strict(), Object.fromEntries(search))
  const params: unknown[] = []; const where: string[] = []
  if (!can(session.role, 'orders:read')) { params.push(session.userId); where.push(`o.assigned_to = $${params.length}`) }
  const scope = where.join(' and ')
  if (query.status) { params.push(query.status); where.push(`o.status = $${params.length}`) }
  if (query.payment_status) { params.push(query.payment_status); where.push(`o.payment_status = $${params.length}`) }
  if (query.q) {
    params.push(`%${escapeLike(query.q)}%`)
    where.push(`(o.order_number ilike $${params.length} escape '\\' or o.customer_name ilike $${params.length} escape '\\' or o.customer_phone like $${params.length} escape '\\')`)
  }
  const scopeParams = scope ? [session.userId] : []
  params.push(query.limit, (query.page - 1) * query.limit)
  const [rows, stats] = await Promise.all([
    deps.db.query<Row>(
      `select o.id, o.order_number, o.customer_name, o.customer_phone, o.total, o.status, o.payment_status, o.payment_method, o.created_at, o.assigned_to,
              u.name as assigned_name, (select count(*) from dpg_app.order_items i where i.order_id = o.id) as item_count, count(*) over() as total_count
         from dpg_app.orders o left join dpg_app.admin_users u on u.id = o.assigned_to
        ${where.length ? `where ${where.join(' and ')}` : ''} order by o.created_at desc, o.id desc limit $${params.length - 1} offset $${params.length}`, params),
    deps.db.query<Row>(
      `select count(*) as total, count(*) filter (where o.status = 'pending') as pending,
              count(*) filter (where o.status in ('received','confirmed','inventory_check')) as processing,
              count(*) filter (where o.status = 'completed') as completed,
              coalesce(sum(o.total) filter (where o.status = 'completed' and o.payment_status = 'paid'), 0) as revenue
         from dpg_app.orders o ${scope ? 'where o.assigned_to = $1' : ''}`, scopeParams),
  ])
  const total = Number(rows[0]?.total_count ?? 0)
  const s = stats[0] ?? {}
  return { status: 200, body: { data: {
    items: rows.map(({ total_count: _c, ...row }) => ({ ...row, total: num(row.total), item_count: Number(row.item_count) })),
    total, page: query.page, limit: query.limit,
    stats: { total: Number(s.total ?? 0), pending: Number(s.pending ?? 0), processing: Number(s.processing ?? 0), completed: Number(s.completed ?? 0), revenue: Number(s.revenue ?? 0) },
  } } }
}

export async function getOrder(deps: Deps, ctx: Context, id: number): Promise<Result> {
  requireAny(ctx, ['orders:read', 'orders:read_assigned'])
  const order = await loadOrder(deps.db, ctx, idOf(id))
  const [items, assignee] = await Promise.all([
    deps.db.query<Row>(
      `select i.id, i.product_id, i.product_name, i.product_sku, i.quantity, i.unit_price, i.total_price, p.image_main_url
         from dpg_app.order_items i left join dpg_app.products p on p.id = i.product_id where i.order_id = $1 order by i.id asc`, [id]),
    order.assigned_to ? deps.db.query<Row>('select name, email from dpg_app.admin_users where id = $1', [order.assigned_to]) : Promise.resolve([]),
  ])
  return { status: 200, body: { data: { ...orderMoney(order), assigned_name: assignee[0]?.name ?? null, items: items.map((i) => ({ ...i, unit_price: num(i.unit_price), total_price: num(i.total_price) })) } } }
}

async function writeOrder(deps: Deps, ctx: Context, id: number, permission: Permission, action: string, apply: (tx: Db, before: Row) => Promise<string[]>): Promise<Result> {
  requirePermission(ctx, permission)
  try {
    const result = await deps.db.transaction(async (tx) => {
      const before = await loadOrder(tx, ctx, idOf(id), true)
      const changed = await apply(tx, before)
      const after = await loadOrder(tx, ctx, id)
      await audit(tx, ctx, 'orders', action, id, pick(before, changed), pick(after, changed), changed)
      return after
    })
    return { status: 200, body: { data: orderMoney(result) } }
  } catch (error) { throw error instanceof ApiError ? error : mapDatabaseError(error) ?? error }
}

export const setOrderStatus = (deps: Deps, ctx: Context, id: number, body: string) => {
  const { status } = validate(z.object({ status: z.enum(ORDER_STATUSES) }).strict(), parseJson(body))
  return writeOrder(deps, ctx, id, 'orders:update_status', 'status', async (tx) => { await tx.query('update dpg_app.orders set status = $2, updated_at = now() where id = $1', [id, status]); return ['status'] })
}
export const setPaymentStatus = (deps: Deps, ctx: Context, id: number, body: string) => {
  const { payment_status } = validate(z.object({ payment_status: z.enum(PAYMENT_STATUSES) }).strict(), parseJson(body))
  return writeOrder(deps, ctx, id, 'orders:edit', 'payment', async (tx) => { await tx.query('update dpg_app.orders set payment_status = $2, updated_at = now() where id = $1', [id, payment_status]); return ['payment_status'] })
}
export const assignOrder = (deps: Deps, ctx: Context, id: number, body: string) => {
  const { user_id } = validate(z.object({ user_id: z.number().int().min(1).max(2_147_483_647).nullable() }).strict(), parseJson(body))
  return writeOrder(deps, ctx, id, 'orders:assign', user_id === null ? 'unassign' : 'assign', async (tx) => {
    await assertAssignee(tx, user_id)
    await tx.query('update dpg_app.orders set assigned_to = $2::int, assigned_at = case when $2::int is null then null else now() end, updated_at = now() where id = $1', [id, user_id])
    return ['assigned_to', 'assigned_at']
  })
}

const orderEditSchema = z.object({
  items: z.array(z.object({ id: z.number().int().min(1), unit_price: z.number().min(0).max(MONEY_MAX), quantity: z.number().int().min(1).max(100000) }).strict()).max(200).optional(),
  vat_rate: z.number().int().min(0).max(100).optional(),
  shipping_fee: z.number().min(0).max(MONEY_MAX).optional(),
  discount: z.number().min(0).max(MONEY_MAX).optional(),
  note: z.string().max(20000).nullable().optional(),
}).strict()

/** Builder save: line prices/quantities, VAT, shipping, discount, note. Subtotal/total are recomputed from the stored lines. */
export const editOrder = (deps: Deps, ctx: Context, id: number, body: string) => {
  const input = validate(orderEditSchema, parseJson(body))
  return writeOrder(deps, ctx, id, 'orders:edit', 'edit', async (tx, before) => {
    for (const item of input.items ?? []) {
      const rows = await tx.query('update dpg_app.order_items set unit_price = $3::numeric, quantity = $4::int, total_price = round($3::numeric * $4::int, 2) where id = $1 and order_id = $2 returning id', [item.id, id, item.unit_price, item.quantity])
      if (!rows[0]) throw new ApiError(400, 'VALIDATION_FAILED', ['items'])
    }
    const subtotal = Number((await tx.query<{ s: string }>('select coalesce(sum(total_price), 0) as s from dpg_app.order_items where order_id = $1', [id]))[0].s)
    const vatRate = input.vat_rate ?? Number(before.vat_rate ?? 0)
    const shipping = input.shipping_fee ?? Number(before.shipping_fee ?? 0)
    const discount = input.discount ?? Number(before.discount ?? 0)
    const total = Math.round((subtotal + subtotal * vatRate / 100 + shipping - discount) * 100) / 100
    if (total < 0) throw new ApiError(400, 'VALIDATION_FAILED', ['discount'])
    await tx.query(
      `update dpg_app.orders set vat_rate = $2::int, shipping_fee = $3::numeric, discount = $4::numeric, note = case when $5::boolean then $6::text else note end, subtotal = $7::numeric, total = $8::numeric, updated_at = now() where id = $1`,
      [id, vatRate, shipping, discount, 'note' in input, input.note ?? null, subtotal, total])
    return ['vat_rate', 'shipping_fee', 'discount', 'subtotal', 'total', ...('note' in input ? ['note'] : [])]
  })
}

// ---------------------------------------------------------------------------------------------------- quotes
const QUOTE_COLUMNS = `q.id, q.quote_number, q.name, q.phone, q.email, q.message, q.status, q.created_at, q.updated_at, q.admin_notes, q.shipping_fee,
  q.vat_rate, q.assigned_to, q.customer_id`

async function loadQuote(db: Db, ctx: Context, id: number, lock = false): Promise<Row> {
  const session = ctx.session!
  const row = (await db.query<Row>(`select ${QUOTE_COLUMNS} from dpg_app.quote_requests q where q.id = $1${lock ? ' for update of q' : ''}`, [id]))[0]
  if (!row || (!can(session.role, 'quotes:read') && row.assigned_to !== session.userId)) throw new ApiError(404, 'NOT_FOUND')
  return row
}
const quoteMoney = (row: Row): Row => ({ ...row, shipping_fee: num(row.shipping_fee) })

export async function listQuotes(deps: Deps, ctx: Context, search: URLSearchParams): Promise<Result> {
  const session = requireAny(ctx, ['quotes:read', 'quotes:read_assigned'])
  const query = validate(z.object({ q: z.string().trim().max(100).optional(), status: z.enum(QUOTE_STATUSES).optional(), ...pageQuery }).strict(), Object.fromEntries(search))
  const params: unknown[] = []; const where: string[] = []
  const restricted = !can(session.role, 'quotes:read')
  if (restricted) { params.push(session.userId); where.push(`q.assigned_to = $${params.length}`) }
  if (query.status) { params.push(query.status); where.push(`q.status = $${params.length}`) }
  if (query.q) {
    params.push(`%${escapeLike(query.q)}%`)
    where.push(`(q.name ilike $${params.length} escape '\\' or q.phone like $${params.length} escape '\\' or q.quote_number ilike $${params.length} escape '\\')`)
  }
  params.push(query.limit, (query.page - 1) * query.limit)
  const [rows, counts] = await Promise.all([
    deps.db.query<Row>(
      `select q.id, q.quote_number, q.name, q.phone, q.email, q.status, q.created_at, q.assigned_to, u.name as assigned_name, count(*) over() as total_count,
              (select coalesce(string_agg(coalesce(i.product_name_snapshot, p.name, 'Sản phẩm'), ', ' order by i.id), '')
                 from (select id, product_id, product_name_snapshot from dpg_app.quote_items where quote_id = q.id order by id limit 3) i left join dpg_app.products p on p.id = i.product_id) as item_names
         from dpg_app.quote_requests q left join dpg_app.admin_users u on u.id = q.assigned_to
        ${where.length ? `where ${where.join(' and ')}` : ''} order by q.created_at desc, q.id desc limit $${params.length - 1} offset $${params.length}`, params),
    deps.db.query<{ status: string; n: string }>(`select q.status, count(*) as n from dpg_app.quote_requests q ${restricted ? 'where q.assigned_to = $1' : ''} group by q.status`, restricted ? [session.userId] : []),
  ])
  const total = Number(rows[0]?.total_count ?? 0)
  return { status: 200, body: { data: { items: rows.map(({ total_count: _c, ...row }) => row), total, page: query.page, limit: query.limit, counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) } } }
}

export async function getQuote(deps: Deps, ctx: Context, id: number): Promise<Result> {
  requireAny(ctx, ['quotes:read', 'quotes:read_assigned'])
  const quote = await loadQuote(deps.db, ctx, idOf(id))
  const items = await deps.db.query<Row>(
    `select i.id, i.product_id, i.quantity, i.note, i.admin_quantity, i.admin_unit_price, i.product_sku_snapshot, i.product_name_snapshot, i.snapshot_at,
            i.list_price_snapshot, i.sale_price_snapshot, p.name as product_name, p.sku as product_sku, p.price as product_price, p.image_main_url
       from dpg_app.quote_items i left join dpg_app.products p on p.id = i.product_id where i.quote_id = $1 order by i.id asc`, [id])
  return { status: 200, body: { data: { ...quoteMoney(quote), items: items.map((i) => ({
    ...i, admin_unit_price: num(i.admin_unit_price), list_price_snapshot: num(i.list_price_snapshot), sale_price_snapshot: num(i.sale_price_snapshot), product_price: num(i.product_price),
  })) } } }
}

async function writeQuote(deps: Deps, ctx: Context, id: number, permission: Permission, action: string, apply: (tx: Db, before: Row) => Promise<string[]>): Promise<Result> {
  requirePermission(ctx, permission)
  try {
    const result = await deps.db.transaction(async (tx) => {
      const before = await loadQuote(tx, ctx, idOf(id), true)
      const changed = await apply(tx, before)
      const after = await loadQuote(tx, ctx, id)
      await audit(tx, ctx, 'quote_requests', action, id, pick(before, changed), pick(after, changed), changed)
      return after
    })
    return { status: 200, body: { data: quoteMoney(result) } }
  } catch (error) { throw error instanceof ApiError ? error : mapDatabaseError(error) ?? error }
}

export const setQuoteStatus = (deps: Deps, ctx: Context, id: number, body: string) => {
  const { status } = validate(z.object({ status: z.enum(QUOTE_STATUSES) }).strict(), parseJson(body))
  return writeQuote(deps, ctx, id, 'quotes:update', 'status', async (tx) => { await tx.query('update dpg_app.quote_requests set status = $2, updated_at = now() where id = $1', [id, status]); return ['status'] })
}
export const assignQuote = (deps: Deps, ctx: Context, id: number, body: string) => {
  const { user_id } = validate(z.object({ user_id: z.number().int().min(1).max(2_147_483_647).nullable() }).strict(), parseJson(body))
  return writeQuote(deps, ctx, id, 'quotes:update', user_id === null ? 'unassign' : 'assign', async (tx) => {
    await assertAssignee(tx, user_id)
    await tx.query('update dpg_app.quote_requests set assigned_to = $2::int, updated_at = now() where id = $1', [id, user_id])
    return ['assigned_to']
  })
}

const quoteSaveSchema = z.object({
  vat_rate: z.number().int().min(0).max(100).optional(),
  shipping_fee: z.number().min(0).max(MONEY_MAX).optional(),
  admin_notes: z.string().max(20000).nullable().optional(),
  items: z.array(z.object({ id: z.number().int().min(1), admin_unit_price: z.number().min(0).max(MONEY_MAX).optional(), admin_quantity: z.number().int().min(1).max(100000).optional() }).strict()).max(200).default([]),
}).strict()

async function saveQuotePricing(tx: Db, id: number, input: z.infer<typeof quoteSaveSchema>): Promise<string[]> {
  for (const item of input.items) {
    const rows = await tx.query(
      'update dpg_app.quote_items set admin_unit_price = coalesce($3::numeric, admin_unit_price), admin_quantity = coalesce($4::int, admin_quantity) where id = $1 and quote_id = $2 returning id',
      [item.id, id, item.admin_unit_price ?? null, item.admin_quantity ?? null])
    if (!rows[0]) throw new ApiError(400, 'VALIDATION_FAILED', ['items'])
  }
  // Working on a quote moves a new request to "resolved" (legacy behaviour); finished/cancelled ones keep their status.
  await tx.query(
    `update dpg_app.quote_requests set vat_rate = coalesce($2::int, vat_rate), shipping_fee = coalesce($3::numeric, shipping_fee),
            admin_notes = case when $4::boolean then $5::text else admin_notes end, status = case when status = 'pending' then 'resolved' else status end, updated_at = now() where id = $1`,
    [id, input.vat_rate ?? null, input.shipping_fee ?? null, 'admin_notes' in input, input.admin_notes ?? null])
  return ['vat_rate', 'shipping_fee', 'admin_notes', 'status']
}

export const saveQuote = (deps: Deps, ctx: Context, id: number, body: string) => {
  const input = validate(quoteSaveSchema, parseJson(body))
  return writeQuote(deps, ctx, id, 'quotes:update', 'save', (tx) => saveQuotePricing(tx, id, input))
}

/** Saves the pricing, then links the requester to CSKH (customer found/created by phone) and marks the quote completed. */
export const completeQuote = (deps: Deps, ctx: Context, id: number, body: string) => {
  const input = validate(quoteSaveSchema, parseJson(body))
  return writeQuote(deps, ctx, id, 'quotes:update', 'complete', async (tx, before) => {
    await saveQuotePricing(tx, id, input)
    const label = `#${before.quote_number ?? id}`
    const existing = (await tx.query<{ id: number; notes: string | null }>('select id, notes from dpg_app.customers where phone = $1 for update', [before.phone]))[0]
    let customerId: number
    if (!existing) {
      customerId = Number((await tx.query<{ id: number }>(
        `insert into dpg_app.customers (full_name, phone, email, source, notes, last_interacted_at) values ($1, $2, $3, 'QUOTE_FORM', $4, now()) returning id`,
        [before.name, before.phone, before.email ?? null, `Khách hàng từ yêu cầu báo giá ${label}`]))[0].id)
    } else {
      customerId = existing.id
      const note = existing.notes ? `${existing.notes}\n---\nNhận báo giá ${label}` : `Nhận báo giá ${label}`
      await tx.query('update dpg_app.customers set last_interacted_at = now(), notes = $2, updated_at = now() where id = $1', [customerId, note])
    }
    await tx.query(`update dpg_app.quote_requests set status = 'completed', customer_id = $2, updated_at = now() where id = $1`, [id, customerId])
    return ['vat_rate', 'shipping_fee', 'admin_notes', 'status', 'customer_id']
  })
}

// ---------------------------------------------------------------------------------------------------- dashboard
const PERIODS = { day: { unit: 'day', days: 30 }, week: { unit: 'week', days: 84 }, month: { unit: 'month', days: 365 }, year: { unit: 'year', days: 1825 } } as const

export async function dashboard(deps: Deps, ctx: Context, search: URLSearchParams): Promise<Result> {
  requirePermission(ctx, 'dashboard:read')
  const { period } = validate(z.object({ period: z.enum(['day', 'week', 'month', 'year']).default('month') }).strict(), Object.fromEntries(search))
  const { unit, days } = PERIODS[period] // static, whitelisted: the only values ever interpolated into SQL
  const done = `o.status in ('completed','delivered') and o.payment_status = 'paid'`
  const [stats, chart, quotes, orders, sold, quoted] = await Promise.all([
    deps.db.query<Row>(
      `select (select count(*) from dpg_app.quote_requests where status = 'pending') as pending_quotes,
              (select count(*) from dpg_app.orders where status = 'pending') as pending_orders,
              (select coalesce(sum(o.total), 0) from dpg_app.orders o where ${done} and o.created_at >= date_trunc('month', now())) as revenue_this_month,
              (select count(*) from dpg_app.orders o where ${done} and o.created_at >= date_trunc('month', now())) as orders_this_month,
              (select coalesce(sum(o.total), 0) from dpg_app.orders o where ${done} and o.created_at >= date_trunc('month', now()) - interval '1 month' and o.created_at < date_trunc('month', now())) as revenue_last_month,
              (select count(*) from dpg_app.products) as total_products, (select count(*) from dpg_app.products where is_active = true) as active_products`),
    deps.db.query<Row>(
      `select date_trunc('${unit}', o.created_at at time zone 'Asia/Ho_Chi_Minh') as date, sum(o.total) as revenue, count(*) as order_count
         from dpg_app.orders o where ${done} and o.created_at >= now() - interval '${days} days' group by 1 order by 1 asc`),
    deps.db.query<Row>(
      `select q.id, q.quote_number, q.name, q.phone, q.created_at, q.status,
              (select coalesce(string_agg(coalesce(i.product_name_snapshot, p.name, 'Sản phẩm'), ', ' order by i.id), '') from (select id, product_id, product_name_snapshot from dpg_app.quote_items where quote_id = q.id order by id limit 3) i left join dpg_app.products p on p.id = i.product_id) as item_names
         from dpg_app.quote_requests q where q.status = 'pending' order by q.created_at desc limit 5`),
    deps.db.query<Row>(`select o.id, o.order_number, o.customer_name, o.customer_phone, o.total, o.payment_status, o.status, o.created_at from dpg_app.orders o where o.status = 'pending' order by o.created_at desc limit 5`),
    deps.db.query<Row>(
      `select oi.product_id, oi.product_name, oi.product_sku, sum(oi.quantity) as total_sold, p.image_main_url
         from dpg_app.order_items oi join dpg_app.orders o on o.id = oi.order_id join dpg_app.products p on p.id = oi.product_id
        where o.status in ('completed','delivered') group by oi.product_id, oi.product_name, oi.product_sku, p.image_main_url order by total_sold desc limit 5`),
    deps.db.query<Row>(
      `select qi.product_id, p.name, p.sku, count(qi.id) as quote_count, p.image_main_url
         from dpg_app.quote_items qi join dpg_app.products p on p.id = qi.product_id group by qi.product_id, p.name, p.sku, p.image_main_url order by quote_count desc limit 5`),
  ])
  const s = stats[0]; const thisMonth = Number(s.revenue_this_month), lastMonth = Number(s.revenue_last_month)
  return { status: 200, body: { data: {
    stats: {
      pending_quotes: Number(s.pending_quotes), pending_orders: Number(s.pending_orders), revenue_this_month: thisMonth, revenue_last_month: lastMonth,
      revenue_growth: lastMonth === 0 ? null : Math.round(((thisMonth - lastMonth) / lastMonth) * 100), orders_this_month: Number(s.orders_this_month),
      total_products: Number(s.total_products), active_products: Number(s.active_products),
    },
    period, revenue: chart.map((r) => ({ date: r.date, revenue: Number(r.revenue), order_count: Number(r.order_count) })),
    pending_quotes: quotes, pending_orders: orders.map((o) => ({ ...o, total: num(o.total) })),
    top_sold: sold.map((r) => ({ ...r, total_sold: Number(r.total_sold) })), top_quoted: quoted.map((r) => ({ ...r, quote_count: Number(r.quote_count) })),
  } } }
}

// ---------------------------------------------------------------------------------------------------- products (bulk)
const BULK_ACTIONS = ['activate', 'deactivate', 'feature', 'unfeature', 'delete'] as const

/** Bulk toggles/delete over the product list. Activation keeps the same guard as the single editor (price + main image). */
export async function bulkProducts(deps: Deps, ctx: Context, body: string): Promise<Result> {
  const { ids, action } = validate(z.object({ ids: z.array(z.number().int().min(1).max(2_147_483_647)).min(1).max(100), action: z.enum(BULK_ACTIONS) }).strict(), parseJson(body))
  const unique = [...new Set(ids)]
  requirePermission(ctx, action === 'delete' ? 'products:delete' : 'products:write')
  if (action === 'activate' || action === 'deactivate') requirePermission(ctx, 'visibility:write')
  try {
    const result = await deps.db.transaction(async (tx) => {
      const rows = await tx.query<Row>('select id, price, list_price, sale_price, stock_status, image_main_url from dpg_app.products where id = any($1) for update', [unique])
      const found = new Set(rows.map((r) => Number(r.id)))
      const skipped: { id: number; reason: string }[] = unique.filter((id) => !found.has(id)).map((id) => ({ id, reason: 'NOT_FOUND' }))
      let targets = rows.map((r) => Number(r.id))
      if (action === 'activate') {
        const blocked = new Map<number, string>()
        for (const r of rows) {
          if (r.stock_status !== 'contact' && !num(r.price) && !num(r.list_price) && !num(r.sale_price)) blocked.set(Number(r.id), 'PRICE_REQUIRED')
          else if (typeof r.image_main_url !== 'string' || r.image_main_url.trim() === '') blocked.set(Number(r.id), 'IMAGE_REQUIRED')
        }
        for (const [id, reason] of blocked) skipped.push({ id, reason })
        targets = targets.filter((id) => !blocked.has(id))
      }
      if (targets.length) {
        if (action === 'delete') await tx.query('delete from dpg_app.products where id = any($1)', [targets])
        else {
          const column = action === 'activate' || action === 'deactivate' ? 'is_active' : 'is_featured'
          await tx.query(`update dpg_app.products set ${column} = $2::boolean, updated_at = now(), version = coalesce(version, 0) + 1 where id = any($1)`, [targets, action === 'activate' || action === 'feature'])
        }
        for (const id of targets) await audit(tx, ctx, 'products', `bulk_${action}`, id, null, null, action === 'delete' ? [] : [action === 'activate' || action === 'deactivate' ? 'is_active' : 'is_featured'])
      }
      return { updated: targets.length, skipped }
    })
    return { status: 200, body: { data: result } }
  } catch (error) { throw error instanceof ApiError ? error : mapDatabaseError(error) ?? error }
}

// ---------------------------------------------------------------------------------------------------- product variants
/** Variant group members (legacy getProductVariants). */
export async function listVariants(deps: Deps, ctx: Context, productId: number): Promise<Result> {
  requirePermission(ctx, 'products:read')
  const current = (await deps.db.query<{ variant_group: string | null }>('select variant_group from dpg_app.products where id = $1', [idOf(productId)]))[0]
  if (!current) throw new ApiError(404, 'NOT_FOUND')
  if (!current.variant_group) return { status: 200, body: { data: { group: null, items: [] } } }
  const rows = await deps.db.query<Row>(
    `select p.id, p.sku, p.name, p.price, p.image_main_url, c.name as color_name, c.hex_code
       from dpg_app.products p left join dpg_app.colors c on c.id = p.color_id where p.variant_group = $1 order by p.id asc limit 200`, [current.variant_group])
  return { status: 200, body: { data: { group: current.variant_group, items: rows.map((r) => ({ ...r, price: num(r.price) })) } } }
}

/** Legacy linkVariant: both products join the current product's group (created as VG-<epoch ms> when it has none). */
export async function linkVariant(deps: Deps, ctx: Context, productId: number, body: string): Promise<Result> {
  requirePermission(ctx, 'products:write')
  const { target_id } = validate(z.object({ target_id: z.number().int().min(1).max(2_147_483_647) }).strict(), parseJson(body))
  if (target_id === productId) throw new ApiError(400, 'VALIDATION_FAILED', ['target_id'])
  try {
    const group = await deps.db.transaction(async (tx) => {
      const rows = await tx.query<{ id: number; variant_group: string | null }>('select id, variant_group from dpg_app.products where id = any($1) for update', [[idOf(productId), target_id]])
      const current = rows.find((r) => r.id === productId), target = rows.find((r) => r.id === target_id)
      if (!current || !target) throw new ApiError(404, 'NOT_FOUND')
      const variantGroup = current.variant_group ?? `VG-${Date.now()}`
      const moved = await tx.query<{ id: number }>(
        `update dpg_app.products set variant_group = $2, updated_at = now(), version = coalesce(version, 0) + 1 where id = any($1) and variant_group is distinct from $2 returning id`, [[productId, target_id], variantGroup])
      for (const row of moved) await audit(tx, ctx, 'products', 'variant_link', row.id, { variant_group: row.id === target_id ? target.variant_group : current.variant_group }, { variant_group: variantGroup }, ['variant_group'])
      return variantGroup
    })
    return { status: 200, body: { data: { group } } }
  } catch (error) { throw error instanceof ApiError ? error : mapDatabaseError(error) ?? error }
}

/** Legacy unlinkVariant: the given product leaves its variant group. */
export async function unlinkVariant(deps: Deps, ctx: Context, productId: number, targetId: number): Promise<Result> {
  requirePermission(ctx, 'products:write')
  try {
    await deps.db.transaction(async (tx) => {
      const rows = await tx.query<{ variant_group: string | null }>('select variant_group from dpg_app.products where id = $1 for update', [idOf(targetId)])
      if (!rows[0]) throw new ApiError(404, 'NOT_FOUND')
      if (rows[0].variant_group) {
        await tx.query('update dpg_app.products set variant_group = null, updated_at = now(), version = coalesce(version, 0) + 1 where id = $1', [targetId])
        await audit(tx, ctx, 'products', 'variant_unlink', targetId, { variant_group: rows[0].variant_group }, { variant_group: null }, ['variant_group'])
      }
    })
    void productId
    return { status: 200, body: { data: { ok: true } } }
  } catch (error) { throw error instanceof ApiError ? error : mapDatabaseError(error) ?? error }
}
