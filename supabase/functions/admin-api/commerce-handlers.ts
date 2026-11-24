// Assignees, dashboard, bulk product actions and product variants. Orders and quote requests moved to sales-handlers.ts (commerce v1, schema dpg_commerce); the legacy order/quote
// handlers were removed. Same rules as the resource engine:
// parameterised SQL only, RBAC on every operation, assigned-only visibility for roles without the "read all"
// permission, audit rows in the same transaction. Totals are always recomputed on the server from stored lines.
import { z } from 'zod'
import { ApiError, mapDatabaseError, requirePermission, type Context, type Db, type Session } from './core.ts'
import { can, type Permission } from './permissions.ts'
import { audit, parseJson, pick, validate } from './resource-handlers.ts'

type Deps = { db: Db }
type Result = { status: number; body: unknown }
type Row = Record<string, unknown>

const ASSIGNABLE_ROLES = ['admin', 'sale_manager', 'sale']
const MONEY_MAX = 99_999_999_999
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value))


function requireAny(ctx: Context, permissions: Permission[]): Session {
  if (!ctx.session) throw new ApiError(401, 'UNAUTHENTICATED')
  const role = ctx.session.role
  if (!permissions.some((permission) => can(role, permission))) throw new ApiError(403, 'FORBIDDEN')
  return ctx.session
}

/** Active staff a record can be assigned to (shown to roles that may assign). */
export async function listAssignees(deps: Deps, ctx: Context): Promise<Result> {
  requireAny(ctx, ['orders:assign'])
  const rows = await deps.db.query('select id, name, role from dpg_app.admin_users where is_active = true and role = any($1) order by name asc, id asc', [ASSIGNABLE_ROLES])
  return { status: 200, body: { data: { items: rows } } }
}

async function assertAssignee(db: Db, userId: number | null) {
  if (userId === null) return
  const rows = await db.query('select id from dpg_app.admin_users where id = $1 and is_active = true and role = any($2)', [userId, ASSIGNABLE_ROLES])
  if (!rows[0]) throw new ApiError(400, 'VALIDATION_FAILED', ['user_id'])
}

const idOf = (value: number) => { if (!Number.isInteger(value) || value < 1) throw new ApiError(404, 'NOT_FOUND'); return value }

// ---------------------------------------------------------------------------------------------------- dashboard
/** Commerce v1 overview: what is waiting for staff (new orders / new quote requests, from dpg_commerce) and catalogue size. No revenue/payment figures:
 * payment and delivery are confirmed outside the system, so nothing here claims money was received. */
/** The commerce schema is applied by its own Owner GO: until then (or after a rollback) the dashboard shows zeros instead of failing. */
const COMMERCE_SCHEMA_MISSING = new Set(['42P01', '3F000', '42501'])
export async function dashboard(deps: Deps, ctx: Context): Promise<Result> {
  requirePermission(ctx, 'dashboard:read')
  const [stats, orders, quotes] = await Promise.all([
    deps.db.query<Row>(
      `select (select count(*) from dpg_commerce.quotes where status = 'new') as new_quotes, (select count(*) from dpg_commerce.orders where status = 'new') as new_orders,
              (select count(*) from dpg_commerce.orders where status = 'processing') as processing_orders, (select count(*) from dpg_commerce.quotes where status = 'processing') as processing_quotes,
              (select count(*) from dpg_app.products) as total_products, (select count(*) from dpg_app.products where is_active = true) as active_products`),
    deps.db.query<Row>(`select id, code, customer_name, customer_phone, total_vnd, line_count, created_at from dpg_commerce.orders where status = 'new' order by created_at desc, id desc limit 5`),
    deps.db.query<Row>(`select id, code, customer_name, customer_phone, line_count, created_at from dpg_commerce.quotes where status = 'new' order by created_at desc, id desc limit 5`),
  ]).catch(async (error) => {
    if (!COMMERCE_SCHEMA_MISSING.has((error as { code?: string })?.code ?? '')) throw error
    const only = await deps.db.query<Row>('select (select count(*) from dpg_app.products) as total_products, (select count(*) from dpg_app.products where is_active = true) as active_products')
    return [[{ new_orders: 0, new_quotes: 0, processing_orders: 0, processing_quotes: 0, ...only[0] }], [], []] as [Row[], Row[], Row[]]
  })
  const s = stats[0]
  return { status: 200, body: { data: {
    stats: { new_orders: Number(s.new_orders), new_quotes: Number(s.new_quotes), processing_orders: Number(s.processing_orders), processing_quotes: Number(s.processing_quotes), total_products: Number(s.total_products), active_products: Number(s.active_products) },
    new_orders: orders.map((o) => ({ ...o, total_vnd: num(o.total_vnd) })), new_quotes: quotes,
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
