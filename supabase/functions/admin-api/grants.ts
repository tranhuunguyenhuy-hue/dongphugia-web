// Generates the column-level grants + RLS policies for the Admin resources straight from resources.ts, so the
// database enforces exactly what the API is allowed to write (defence in depth: a bug in the handlers still cannot
// touch other columns/tables). Pure function: used by scripts/m3/generate-admin-resource-grants.mts and by a test
// that fails when the committed SQL drifts from the definitions.
import type { ResourceDef } from './resources.ts'

export interface GrantOptions {
  role: string
  policyPrefix: string
  /** SQL that must raise when the target is not the intended database (TEST contract / Production ref). */
  guard: string
  title: string
  /** Tables whose privileges were already granted by an earlier migration (rollback keeps their SELECT). */
  baseTables?: readonly string[]
  /** `table.command` policies created by an earlier migration: the rollback must not drop them. */
  basePolicies?: readonly string[]
  /** Statements that restore column privileges the earlier migration granted and the rollback's REVOKE removes. */
  rollbackRegrant?: readonly string[]
  /** Privileges for handlers that are not driven by a resource definition. */
  extra?: readonly ExtraGrant[]
}

export interface ExtraGrant { table: string; select?: readonly string[]; insert?: readonly string[]; update?: readonly string[]; delete?: boolean }
type Command = 'select' | 'insert' | 'update' | 'delete'
type TableGrant = { select: Set<string>; insert: Set<string>; update: Set<string>; delete: boolean; sequence: boolean }

const sorted = (values: Iterable<string>) => [...values].sort()
const cols = (values: Iterable<string>) => sorted(values).join(', ')

export function collectGrants(resources: readonly ResourceDef[], extra: readonly ExtraGrant[] = []): Map<string, TableGrant> {
  const tables = new Map<string, TableGrant>()
  const entry = (table: string) => {
    let grant = tables.get(table)
    if (!grant) { grant = { select: new Set(), insert: new Set(), update: new Set(), delete: false, sequence: false }; tables.set(table, grant) }
    return grant
  }
  for (const def of resources) {
    const grant = entry(def.table)
    grant.select.add('id')
    for (const field of def.fields) if (!field.virtual) grant.select.add(field.name)
    for (const name of def.existingColumns ?? []) grant.select.add(name)
    const writable = def.fields.filter((field) => !field.readOnly && !field.virtual).map((field) => field.name)
    if (def.write && def.create) {
      for (const name of writable) grant.insert.add(name)
      if (def.autoSlug) grant.insert.add(def.autoSlug.column)
      for (const name of def.createColumns ?? []) grant.insert.add(name)
      grant.sequence = true
    }
    const canUpdate = Boolean(def.write && def.update !== false)
    const softDelete = Boolean(def.write && def.delete === 'soft')
    if (canUpdate) {
      for (const field of def.fields) if (!field.readOnly && !field.virtual && !field.createOnly) grant.update.add(field.name)
      for (const name of def.hookColumns ?? []) grant.update.add(name)
    }
    if (canUpdate || softDelete) { if (!def.noUpdatedAt) grant.update.add('updated_at'); if (def.versioned) grant.update.add('version') }
    if (softDelete) grant.update.add('is_active')
    if (def.write && def.delete === 'hard') grant.delete = true
    for (const relation of def.relations ?? []) {
      const join = entry(relation.table)
      join.select.add(relation.owner); join.select.add(relation.target)
      join.insert.add(relation.owner); join.insert.add(relation.target)
      join.delete = true
      if (relation.recount) { const target = entry(relation.recount.table); target.select.add(relation.recount.column); target.update.add(relation.recount.column) }
    }
  }
  for (const grant of extra) {
    const entry = tables.get(grant.table) ?? { select: new Set<string>(), insert: new Set<string>(), update: new Set<string>(), delete: false, sequence: false }
    tables.set(grant.table, entry)
    for (const name of grant.select ?? []) entry.select.add(name)
    for (const name of grant.insert ?? []) entry.insert.add(name)
    for (const name of grant.update ?? []) entry.update.add(name)
    if (grant.delete) entry.delete = true
    if (grant.insert?.length) entry.sequence = true
  }
  return tables
}

const commandsOf = (grant: TableGrant): Command[] => {
  const out: Command[] = ['select']
  if (grant.insert.size) out.push('insert')
  if (grant.update.size) out.push('update')
  if (grant.delete) out.push('delete')
  return out
}

export function generateAdminResourceMigration(resources: readonly ResourceDef[], options: GrantOptions) {
  const tables = collectGrants(resources, options.extra)
  const names = sorted(tables.keys())
  const base = new Set(options.baseTables ?? [])
  const { role } = options

  const forward: string[] = [
    `-- ${options.title}`,
    '-- GENERATED from supabase/functions/admin-api/resources.ts by scripts/m3/generate-admin-resource-grants.mts - do not edit by hand.',
    '-- Forward migration, idempotent (grants and policies are re-created). Operator MUST verify the runner targets the intended project.',
    '-- guard:begin', options.guard.trim(), '-- guard:end', '',
    `grant usage on schema dpg_app to ${role};`,
  ]
  for (const table of names) {
    const grant = tables.get(table)!
    forward.push(`-- ${table}`)
    forward.push(`grant select (${cols(grant.select)}) on dpg_app.${table} to ${role};`)
    if (grant.insert.size) forward.push(`grant insert (${cols(grant.insert)}) on dpg_app.${table} to ${role};`)
    if (grant.update.size) forward.push(`grant update (${cols(grant.update)}) on dpg_app.${table} to ${role};`)
    if (grant.delete) forward.push(`grant delete on dpg_app.${table} to ${role};`)
    if (grant.sequence) forward.push(`grant usage, select on sequence dpg_app.${table}_id_seq to ${role};`)
  }
  const specs = names.flatMap((table) => commandsOf(tables.get(table)!).map((command) => `    ('${table}','${command}')`))
  forward.push('', '-- RLS is enabled on every dpg_app table: allow the role exactly the commands it was granted.', 'do $$', 'declare spec record;', 'begin',
    '  for spec in select * from (values', specs.join(',\n'), '  ) as t(tbl,cmd) loop',
    `    execute format('drop policy if exists %I on dpg_app.%I', '${options.policyPrefix}'||spec.cmd, spec.tbl);`,
    "    if spec.cmd='insert' then",
    `      execute format('create policy %I on dpg_app.%I for insert to ${role} with check (true)', '${options.policyPrefix}'||spec.cmd, spec.tbl);`,
    "    elsif spec.cmd='update' then",
    `      execute format('create policy %I on dpg_app.%I for update to ${role} using (true) with check (true)', '${options.policyPrefix}'||spec.cmd, spec.tbl);`,
    '    else',
    `      execute format('create policy %I on dpg_app.%I for %s to ${role} using (true)', '${options.policyPrefix}'||spec.cmd, spec.tbl, spec.cmd);`,
    '    end if;', '  end loop;', 'end $$;', '')

  const rollback: string[] = [
    `-- Rollback of: ${options.title}`,
    '-- GENERATED - removes only what the forward migration granted (tables owned by an earlier migration keep their SELECT).', '',
  ]
  for (const table of names) {
    rollback.push(base.has(table)
      ? `revoke insert, update, delete on dpg_app.${table} from ${role};`
      : `revoke all on dpg_app.${table} from ${role};`)
    if (tables.get(table)!.sequence) rollback.push(`revoke all on sequence dpg_app.${table}_id_seq from ${role};`)
  }
  if (options.rollbackRegrant?.length) rollback.push(...options.rollbackRegrant)
  const kept = (options.basePolicies ?? []).map((policy) => `'${policy}'`)
  rollback.push('do $$', 'declare spec record;', 'begin', '  for spec in select * from (values', specs.join(',\n'), '  ) as t(tbl,cmd) loop',
    `    if ${kept.length ? `(spec.tbl||'.'||spec.cmd) <> all (array[${kept.join(', ')}])` : 'true'} then`,
    `      execute format('drop policy if exists %I on dpg_app.%I', '${options.policyPrefix}'||spec.cmd, spec.tbl);`,
    '    end if;', '  end loop;', 'end $$;', '')
  return { forward: forward.join('\n'), rollback: rollback.join('\n') }
}
