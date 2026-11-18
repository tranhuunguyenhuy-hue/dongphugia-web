// Generic, parameterised CRUD engine driven by resources.ts. Every identifier below comes from a static
// definition; request values are bind parameters only. Writes are transactional: row change, relation rows,
// counters and the audit entry commit or roll back together.
import { ApiError, mapDatabaseError, requirePermission, slugify, type Context, type Db } from './core.ts'
import { can, type AdminRole } from './permissions.ts'
import { allowsNull, resourceBodySchemas, resourceQuerySchema, parseAllowedMediaHosts } from './validation.ts'
import { RESOURCES, columnFields, resourceByKey, writableFields, type FieldDef, type ResourceDef, type Row, type SqlRaw } from './resources.ts'

export interface ResourceDeps { db: Db; allowedMediaHosts?: string; hashPassword?: (plain: string) => Promise<string> }
type Result = { status: number; body: unknown }

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)
const isRaw = (value: unknown): value is SqlRaw => typeof value === 'object' && value !== null && 'raw' in value
export const parseJson = (text: string): unknown => { try { return JSON.parse(text || '{}') } catch { throw new ApiError(400, 'INVALID_JSON') } }
type Issue = { path: PropertyKey[] }
export function validate<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Issue[] } } }, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    // Only property NAMES of the invalid inputs are reported (never values) so forms can highlight them.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path[issue.path[0] === 'input' ? 1 : 0]).filter((name): name is string => typeof name === 'string' && /^[a-z_][a-z0-9_]*$/.test(name)))].slice(0, 20)
    throw new ApiError(400, 'VALIDATION_FAILED', fields)
  }
  return result.data
}

const quote = (identifier: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error('INVALID_IDENTIFIER')
  return identifier
}
const T = (def: ResourceDef) => `dpg_app.${quote(def.table)}`

function readableSelect(def: ResourceDef, alias = 't') {
  const columns = ['id', ...columnFields(def).map((field) => field.name)].map((name) => `${alias}.${quote(name)}`)
  for (const relation of def.relations ?? []) {
    columns.push(`(select coalesce(json_agg(r.${quote(relation.target)} order by r.${quote(relation.target)}), '[]'::json) from dpg_app.${quote(relation.table)} r where r.${quote(relation.owner)} = ${alias}.id) as ${quote(relation.input)}`)
  }
  return columns.join(', ')
}

/** Field metadata for the SPA forms. Contains no permission strings or SQL. */
export function resourceMeta(role: AdminRole) {
  return RESOURCES.filter((def) => can(role, def.read)).map((def) => ({
    key: def.key, label: def.label, group: def.group, inNav: Boolean(def.write) && !def.hideFromNav,
    canCreate: Boolean(def.create && def.write && can(role, def.write)),
    canUpdate: Boolean(def.write && def.update !== false && can(role, def.write)),
    canDelete: Boolean(def.delete && can(role, def.remove ?? def.write ?? def.read) && def.write),
    versioned: Boolean(def.versioned), searchable: def.search.length > 0,
    fields: def.fields.map((field) => ({
      name: field.name, label: field.label, kind: field.kind, required: Boolean(field.required), max: field.max, min: field.min,
      options: field.options, ref: field.ref, upload: field.upload, createOnly: Boolean(field.createOnly), readOnly: Boolean(field.readOnly), nullable: allowsNull(field), list: Boolean(field.list), slugFrom: field.slugFrom, initial: field.initial,
      editable: !field.readOnly && (!field.permission || can(role, field.permission)),
    })),
    relations: (def.relations ?? []).map((r) => ({ input: r.input, label: r.label, ref: r.ref })),
    filters: def.filters ?? [],
  }))
}

export function findResource(key: string): ResourceDef {
  const def = resourceByKey(key)
  if (!def) throw new ApiError(404, 'NOT_FOUND')
  return def
}

export async function listResource(deps: ResourceDeps, ctx: Context, def: ResourceDef, search: URLSearchParams): Promise<Result> {
  requirePermission(ctx, def.read)
  const query = validate(resourceQuerySchema(def), Object.fromEntries(search)) as Record<string, unknown> & { q?: string; page: number; limit: number }
  const params: unknown[] = []
  const where: string[] = []
  if (query.q && def.search.length) {
    params.push(`%${escapeLike(query.q)}%`)
    where.push(`(${def.search.map((column) => `t.${quote(column)} ilike $${params.length} escape '\\'`).join(' or ')})`)
  }
  for (const filter of def.filters ?? []) {
    if (query[filter.name] !== undefined) { params.push(query[filter.name]); where.push(`t.${quote(filter.name)} = $${params.length}`) }
  }
  const listColumns = ['id', ...columnFields(def).filter((field) => field.list).map((field) => field.name)].map((name) => `t.${quote(name)}`)
  params.push(query.limit, (query.page - 1) * query.limit)
  const rows = await deps.db.query<Row>(
    `select ${listColumns.join(', ')}, count(*) over() as total from ${T(def)} t
      ${where.length ? `where ${where.join(' and ')}` : ''} order by ${def.orderBy.split(',').map((part) => `t.${part.trim()}`).join(', ')}
      limit $${params.length - 1} offset $${params.length}`, params)
  const total = Number(rows[0]?.total ?? 0)
  return { status: 200, body: { data: { items: rows.map(({ total: _total, ...row }) => row), total, page: query.page, limit: query.limit } } }
}

/** Compact id/label pairs for dropdowns (categories, tags...). Needs only the referenced resource's read permission. */
export async function optionsResource(deps: ResourceDeps, ctx: Context, def: ResourceDef): Promise<Result> {
  requirePermission(ctx, def.read)
  const rows = await deps.db.query<Row>(`select t.id, t.${quote(def.optionLabel)} as label from ${T(def)} t order by t.${quote(def.optionLabel)} asc, t.id asc limit 500`)
  return { status: 200, body: { data: { items: rows } } }
}

async function loadRow(db: Db, def: ResourceDef, id: number, lock = false): Promise<Row | undefined> {
  const extra = (def.existingColumns ?? []).map((name) => `t.${quote(name)} as ${quote(`__${name}`)}`)
  const select = [readableSelect(def), ...extra].join(', ')
  return (await db.query<Row>(`select ${select} from ${T(def)} t where t.id = $1${lock ? ' for update of t' : ''}`, [id]))[0]
}
const services = (deps: ResourceDeps) => ({ hashPassword: deps.hashPassword ?? (() => { throw new ApiError(500, 'INTERNAL') }) })
const stripExtra = (row: Row): Row => Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('__')))
const existingForHook = (row: Row): Row => {
  const out: Row = { ...stripExtra(row) }
  for (const [key, value] of Object.entries(row)) if (key.startsWith('__')) out[key.slice(2)] = value
  return out
}

export async function getResource(deps: ResourceDeps, ctx: Context, def: ResourceDef, id: number): Promise<Result> {
  requirePermission(ctx, def.read)
  const row = await loadRow(deps.db, def, id)
  if (!row) throw new ApiError(404, 'NOT_FOUND')
  return { status: 200, body: { data: stripExtra(row) } }
}

type Assignment = { column: string; expr: string; value?: unknown; bind: boolean }
function assignment(field: FieldDef | undefined, column: string, value: unknown, nextParam: () => string): Assignment {
  if (isRaw(value)) return { column: quote(column), expr: value.raw, bind: false }
  if (field?.kind === 'json' && value !== null) return { column: quote(column), expr: `${nextParam()}::jsonb`, value: JSON.stringify(value), bind: true }
  if (field?.kind === 'strings' && value !== null) return { column: quote(column), expr: `array(select jsonb_array_elements_text(${nextParam()}::jsonb))`, value: JSON.stringify(value), bind: true }
  return { column: quote(column), expr: nextParam(), value, bind: true }
}

function requireFieldPermissions(ctx: Context, def: ResourceDef, input: Row) {
  for (const field of writableFields(def)) if (field.permission && field.name in input) requirePermission(ctx, field.permission)
}

/** Audit row in the portable base shape (user, action, entity, old/new values, ip): Production's audit_logs has no
 * request_id/changed_fields columns, so that metadata travels inside new_value._meta. */
export async function audit(tx: Db, ctx: Context, entity: string, action: string, id: number, oldValue: Row | null, newValue: Row | null, changed: string[]) {
  await tx.query(
    `insert into dpg_app.audit_logs (user_id, action, entity_type, entity_id, old_value, new_value, ip_address)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [ctx.session!.userId, `${entity}.${action}`, entity, id, oldValue ? JSON.stringify(oldValue) : null,
      JSON.stringify({ ...(newValue ?? {}), _meta: { request_id: ctx.request_id, changed_fields: changed } }), ctx.ip.slice(0, 64) || null])
}
export const pick = (row: Row | null | undefined, keys: string[]): Row => Object.fromEntries(keys.filter((key) => row && key in row).map((key) => [key, row![key]]))

async function replaceRelations(tx: Db, def: ResourceDef, id: number, input: Row, previous: Row | undefined) {
  for (const relation of def.relations ?? []) {
    const ids = input[relation.input]
    if (!Array.isArray(ids)) continue
    const unique = [...new Set(ids as number[])]
    const before = (await tx.query<{ id: number }>(`select ${quote(relation.target)} as id from dpg_app.${quote(relation.table)} where ${quote(relation.owner)} = $1`, [id])).map((r) => Number(r.id))
    await tx.query(`delete from dpg_app.${quote(relation.table)} where ${quote(relation.owner)} = $1`, [id])
    if (unique.length) {
      await tx.query(
        `insert into dpg_app.${quote(relation.table)} (${quote(relation.owner)}, ${quote(relation.target)})
         select $1::int, v::int from jsonb_array_elements_text($2::jsonb) v`, [id, JSON.stringify(unique)])
    }
    await recount(tx, relation, [...new Set([...before, ...unique])])
    if (previous) previous[relation.input] = before
  }
}
async function recount(tx: Db, relation: NonNullable<ResourceDef['relations']>[number], targetIds: number[]) {
  if (!relation.recount || !targetIds.length) return
  const { table, column } = relation.recount
  await tx.query(
    `update dpg_app.${quote(table)} set ${quote(column)} = (select count(*) from dpg_app.${quote(relation.table)} x where x.${quote(relation.target)} = dpg_app.${quote(table)}.id)
      where id in (select v::int from jsonb_array_elements_text($1::jsonb) v)`, [JSON.stringify(targetIds)])
}

export async function createResource(deps: ResourceDeps, ctx: Context, def: ResourceDef, body: string): Promise<Result> {
  if (!def.create || !def.write) throw new ApiError(404, 'NOT_FOUND')
  requirePermission(ctx, def.write)
  const { input } = validate(resourceBodySchemas(def, parseAllowedMediaHosts(deps.allowedMediaHosts)).create, parseJson(body)) as { input: Row }
  requireFieldPermissions(ctx, def, input)
  try {
    const id = await deps.db.transaction(async (tx) => {
      const hook = await def.hook?.({ tx, mode: 'create', input, ctx, services: services(deps) })
      const sets: Record<string, unknown> = { ...(hook?.set ?? {}) }
      if (def.autoSlug) sets[def.autoSlug.column] = `${slugify(String(input[def.autoSlug.from] ?? ''))}-${Date.now()}`
      const params: unknown[] = []
      const columns: string[] = [], values: string[] = []
      const push = (column: string, value: unknown, field?: FieldDef) => {
        const a = assignment(field, column, value, () => `$${params.length + 1}`)
        if (a.bind) params.push(a.value)
        columns.push(a.column); values.push(a.expr)
      }
      for (const field of writableFields(def)) if (field.name in input && input[field.name] !== undefined) push(field.name, input[field.name], field)
      for (const [column, value] of Object.entries(sets)) push(column, value)
      const insert = columns.length
        ? `insert into ${T(def)} (${columns.join(', ')}) values (${values.join(', ')}) returning id`
        : `insert into ${T(def)} default values returning id`
      const created = Number((await tx.query<{ id: number }>(insert, params))[0].id)
      await replaceRelations(tx, def, created, input, undefined)
      const after = await loadRow(tx, def, created)
      await audit(tx, ctx, def.key, 'create', created, null, pick(after, [...Object.keys(input), ...Object.keys(sets)]), [...Object.keys(input)])
      return created
    })
    const row = await loadRow(deps.db, def, id)
    return { status: 201, body: { data: row ? stripExtra(row) : { id } } }
  } catch (error) {
    throw error instanceof ApiError ? error : mapDatabaseError(error) ?? error
  }
}

export async function updateResource(deps: ResourceDeps, ctx: Context, def: ResourceDef, id: number, body: string): Promise<Result> {
  if (!def.write || def.update === false) throw new ApiError(404, 'NOT_FOUND')
  requirePermission(ctx, def.write)
  const { input, expected_version } = validate(resourceBodySchemas(def, parseAllowedMediaHosts(deps.allowedMediaHosts)).update, parseJson(body)) as { input: Row; expected_version?: number }
  requireFieldPermissions(ctx, def, input)
  try {
    const after = await deps.db.transaction(async (tx) => {
      const raw = await loadRow(tx, def, id, true)
      if (!raw) throw new ApiError(404, 'NOT_FOUND')
      const before = stripExtra(raw)
      if (def.versioned && expected_version !== undefined && Number(before.version) !== expected_version) throw new ApiError(409, 'VERSION_CONFLICT')
      const hook = await def.hook?.({ tx, mode: 'update', existing: existingForHook(raw), input, ctx, services: services(deps) })
      const params: unknown[] = [id]
      const sets: string[] = []
      const push = (column: string, value: unknown, field?: FieldDef) => {
        const a = assignment(field, column, value, () => `$${params.length + 1}`)
        if (a.bind) params.push(a.value)
        sets.push(`${a.column} = ${a.expr}`)
      }
      const direct = writableFields(def).filter((field) => !field.createOnly && field.name in input && input[field.name] !== undefined)
      for (const field of direct) push(field.name, input[field.name], field)
      for (const [column, value] of Object.entries(hook?.set ?? {})) push(column, value)
      if (!def.noUpdatedAt) sets.push('updated_at = now()')
      if (def.versioned) sets.push('version = coalesce(version, 0) + 1')
      await tx.query(`update ${T(def)} set ${sets.join(', ')} where id = $1`, params)
      await replaceRelations(tx, def, id, input, before)
      const fresh = (await loadRow(tx, def, id))!
      const changed = [...direct.map((f) => f.name), ...(def.relations ?? []).filter((r) => Array.isArray(input[r.input])).map((r) => r.input), ...Object.keys(hook?.set ?? {})]
      await audit(tx, ctx, def.key, 'update', id, pick(before, changed), pick(fresh, changed), changed)
      return fresh
    })
    return { status: 200, body: { data: stripExtra(after) } }
  } catch (error) {
    throw error instanceof ApiError ? error : mapDatabaseError(error) ?? error
  }
}

export async function deleteResource(deps: ResourceDeps, ctx: Context, def: ResourceDef, id: number, body: string): Promise<Result> {
  if (!def.write || !def.delete) throw new ApiError(404, 'NOT_FOUND')
  requirePermission(ctx, def.remove ?? def.write)
  const { expected_version } = validate(resourceBodySchemas(def, parseAllowedMediaHosts(deps.allowedMediaHosts)).remove, parseJson(body)) as { expected_version?: number }
  try {
    const outcome = await deps.db.transaction(async (tx) => {
      const raw = await loadRow(tx, def, id, true)
      if (!raw) throw new ApiError(404, 'NOT_FOUND')
      const before = stripExtra(raw)
      if (def.versioned && expected_version !== undefined && Number(before.version) !== expected_version) throw new ApiError(409, 'VERSION_CONFLICT')
      const hook = await def.hook?.({ tx, mode: 'delete', existing: existingForHook(raw), input: {}, ctx, services: services(deps) })
      let result: 'deleted' | 'unpublished' | 'deactivated'
      if (hook?.instead || def.delete === 'soft') {
        const params: unknown[] = [id]
        const sets: string[] = []
        const patch = hook?.instead ?? { is_active: false }
        for (const [column, value] of Object.entries(patch)) {
          if (isRaw(value)) sets.push(`${quote(column)} = ${value.raw}`)
          else { params.push(value); sets.push(`${quote(column)} = $${params.length}`) }
        }
        if (!def.noUpdatedAt) sets.push('updated_at = now()')
        if (def.versioned) sets.push('version = coalesce(version, 0) + 1')
        await tx.query(`update ${T(def)} set ${sets.join(', ')} where id = $1`, params)
        result = hook?.instead ? 'unpublished' : 'deactivated'
      } else {
        const targets: Record<string, number[]> = {}
        for (const relation of def.relations ?? []) {
          targets[relation.input] = (await tx.query<{ id: number }>(`select ${quote(relation.target)} as id from dpg_app.${quote(relation.table)} where ${quote(relation.owner)} = $1`, [id])).map((r) => Number(r.id))
        }
        await tx.query(`delete from ${T(def)} where id = $1`, [id])
        for (const relation of def.relations ?? []) await recount(tx, relation, targets[relation.input])
        result = 'deleted'
      }
      await audit(tx, ctx, def.key, result === 'deleted' ? 'delete' : result === 'unpublished' ? 'unpublish' : 'deactivate', id, before, null, [])
      return result
    })
    return { status: 200, body: { data: { ok: true, result: outcome } } }
  } catch (error) {
    throw error instanceof ApiError ? error : mapDatabaseError(error) ?? error
  }
}
