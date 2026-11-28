// Trusted backup scope for the Production backup lane (DPG-42). The allowlist is the reviewed file
// scripts/backup/backup-scope.json at the exact checked-out source; a bundle's scope.json is only data and is
// accepted only when it equals one reviewed version exactly. Bundles without scope.json are historical v1 (limited).
// Usage:
//   node backup-scope.mjs schemas                       -> current approved schemas, comma separated
//   node backup-scope.mjs check-discovered <file>       -> fail unless every discovered dpg_* schema with tables is in scope or excluded
//   node backup-scope.mjs write-bundle-scope <out>      -> write the bundle scope.json for the current version
//   node backup-scope.mjs resolve-bundle <bundle-dir>   -> print "version=<v> coverage=<full|limited> schemas=<a,b>"; exit 1 if untrusted
//   node backup-scope.mjs runtime-roles [version]       -> reviewed runtime roles (comma separated) recovery must reproduce
//   node backup-scope.mjs check-runtime-roles <version> <roles.txt> -> the bundle's roles.txt must record each reviewed runtime role
//                                                         (present: login + membership policy exactly as reviewed; absent: no trace)
//   node backup-scope.mjs platform-roles [version]      -> provider-controlled principals whose membership edges are exported, not replayed
//   node backup-scope.mjs role-settings [version]       -> JSON allowlist (setting name -> value regex) for role settings written to roles.txt
//   node backup-scope.mjs check-roles <version> <roles.txt> -> runtime roles + platform edge shapes + role-setting allowlist + no multi-grantor
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/

export function loadContract(path = join(here, 'backup-scope.json')) {
  const c = JSON.parse(readFileSync(path, 'utf8'))
  if (c.contract !== 'dpg-production-backup-scope') throw new Error('SCOPE_CONTRACT_INVALID')
  const v = c.versions?.[String(c.current_version)]
  if (!v || !Array.isArray(v.schemas) || !v.schemas.length) throw new Error('SCOPE_CURRENT_VERSION_INVALID')
  for (const ver of Object.values(c.versions)) for (const s of ver.schemas) if (!IDENT.test(s)) throw new Error('SCOPE_SCHEMA_NAME_INVALID')
  for (const s of Object.keys(c.excluded ?? {})) if (!IDENT.test(s) || !String(c.excluded[s] ?? '').trim()) throw new Error('SCOPE_EXCLUSION_INVALID')
  for (const k of Object.keys(c.versions)) {
    runtimeRoles(c, k)
    for (const r of platformRoles(c, k)) if (!IDENT.test(r)) throw new Error('SCOPE_PLATFORM_ROLE_INVALID')
    for (const [name, pat] of Object.entries(roleSettingsAllow(c, k))) { if (!/^[a-z_][a-z0-9_.]{0,62}$/.test(name)) throw new Error('SCOPE_ROLE_SETTING_INVALID'); new RegExp(pat) }
  }
  return c
}


export function runtimeRoles(c, version = c.current_version) {
  const rr = c.versions[String(version)]?.runtime_roles ?? {}
  for (const [name, spec] of Object.entries(rr)) {
    if (!IDENT.test(name) || name.startsWith('pg_') || !spec || typeof spec.login !== 'boolean') throw new Error('SCOPE_RUNTIME_ROLE_INVALID')
    for (const g of Object.keys(spec.member_of ?? {})) if (!IDENT.test(g) || g.startsWith('pg_')) throw new Error('SCOPE_RUNTIME_ROLE_INVALID')
  }
  return rr
}

// roles.txt (m5-roles.sql output) must carry exactly one runtime_role line per reviewed role, consistent with the rest of the file,
// and a role recorded as present must have the reviewed login attribute and the reviewed membership/SET/INHERIT policy. A bundle
// that silently omits the role (or its edges) therefore fails closed instead of being reported as complete recovery.
export function checkRuntimeRoles(c, version, lines) {
  const rr = runtimeRoles(c, version)
  const rows = lines.map((l) => l.trim()).filter(Boolean)
  const marks = rows.filter((l) => l.startsWith('runtime_role '))
  const names = Object.keys(rr)
  if (!names.length) return marks.length ? { ok: false, reason: 'runtime_role_unreviewed' } : { ok: true }
  for (const m of marks) if (!names.includes(m.split(' ')[1])) return { ok: false, reason: 'runtime_role_unreviewed' }
  for (const [name, spec] of Object.entries(rr)) {
    const mine = marks.filter((m) => m.split(' ')[1] === name)
    if (mine.length !== 1 || !/^runtime_role \S+ (present|absent)$/.test(mine[0])) return { ok: false, reason: 'runtime_roles_missing', role: name }
    const present = mine[0].endsWith(' present')
    const exists = rows.includes(`roleexists ${name}`)
    const attr = rows.find((l) => l.startsWith(`roleattr ${name} `))
    const edges = rows.filter((l) => l.startsWith('member ') && l.split(' ')[2] === name)
    if (!present) {
      if (exists || attr || edges.length || rows.some((l) => l.startsWith(`rolesetting ${name} `))) return { ok: false, reason: 'runtime_role_inconsistent', role: name }
      continue
    }
    if (!exists || !attr) return { ok: false, reason: 'runtime_role_inconsistent', role: name }
    const kv = Object.fromEntries(attr.split(' ').slice(2).map((p) => p.split('=')))
    if (String(spec.login) !== kv.login || (typeof spec.role_inherit === 'boolean' && String(spec.role_inherit) !== kv.inherit) || kv.super !== 'false' || kv.createrole !== 'false' || kv.createdb !== 'false' || kv.replication !== 'false' || kv.bypassrls !== 'false') return { ok: false, reason: 'runtime_role_policy_differs', role: name }
    const want = Object.entries(spec.member_of ?? {})
    if (edges.length !== want.length) return { ok: false, reason: 'runtime_role_policy_differs', role: name }
    for (const [g, o] of want) {
      const e = edges.find((l) => l.split(' ')[1] === g)
      if (!e || e !== `member ${g} ${name} admin=${o.admin} inherit=${o.inherit} set=${o.set}`) return { ok: false, reason: 'runtime_role_policy_differs', role: name }
    }
  }
  return { ok: true }
}

export function platformRoles(c, version = c.current_version) { return [...(c.versions[String(version)]?.platform_roles ?? [])] }
export function roleSettingsAllow(c, version = c.current_version) { return { ...(c.versions[String(version)]?.role_settings ?? {}) } }
function platformShapes(c, version) { return c.versions[String(version)]?.platform_edge_shapes ?? [] }

// Whole-file guard for a v2 roles.txt, run by the restore BEFORE any role is created and by the dump before anything is uploaded:
// no rejected role setting (name only is ever reported), every exported setting matches the reviewed allowlist, no ambiguous
// (group, member) pair with several grantors outside the provider-controlled principals, and every provider-controlled edge has a
// reviewed shape (a different shape could be an elevated grant that a replay would silently collapse).
export function checkRolesFile(c, version, lines) {
  const rows = lines.map((l) => l.trim()).filter(Boolean)
  const allow = roleSettingsAllow(c, version)
  const platform = new Set(platformRoles(c, version))
  const shapes = platformShapes(c, version)
  for (const l of rows) {
    const p = l.split(' ')
    if (p[0] === 'rolesetting_rejected') return { ok: false, reason: p[3] === 'value_rejected' ? 'role_setting_value_rejected' : 'role_setting_unreviewed', role: p[1], setting: /^[a-z_][a-z0-9_.]{0,62}$/.test(p[2] ?? '') ? p[2] : 'invalid_name' }
    if (p[0] === 'member_conflict') return { ok: false, reason: 'role_edge_multi_grantor_unsupported', role: p[2] }
    if (p[0] === 'rolesetting') {
      const kv = l.slice(l.indexOf(' ', 'rolesetting '.length) + 1), eq = kv.indexOf('='), name = eq < 0 ? kv : kv.slice(0, eq), value = eq < 0 ? '' : kv.slice(eq + 1)
      if (!Object.hasOwn(allow, name)) return { ok: false, reason: 'role_setting_unreviewed', role: p[1], setting: /^[a-z_][a-z0-9_.]{0,62}$/.test(name) ? name : 'invalid_name' }
      if (!new RegExp(allow[name]).test(value)) return { ok: false, reason: 'role_setting_value_rejected', role: p[1], setting: name }
    }
    if (p[0] === 'platform_edge') {
      const m = /^platform_edge (\S+) (\S+) grantor=(\S+) admin=(true|false) inherit=(true|false) set=(true|false)$/.exec(l)
      if (!m) return { ok: false, reason: 'platform_edge_malformed' }
      const [, group, member, grantor, admin, inherit, set] = m
      if (!platform.has(member) || !shapes.some((x) => x.grantor === grantor && String(x.admin) === admin && String(x.inherit) === inherit && String(x.set) === set)) return { ok: false, reason: 'platform_edge_unreviewed', role: group }
    }
  }
  return { ok: true }
}

export function currentSchemas(c) { return [...c.versions[String(c.current_version)].schemas] }

export function checkDiscovered(c, discovered) {
  const names = discovered.map((s) => s.trim()).filter(Boolean)
  for (const s of names) if (!IDENT.test(s)) return { ok: false, reason: 'discovered_name_invalid', uncovered: [s] }
  const covered = new Set([...currentSchemas(c), ...Object.keys(c.excluded ?? {})])
  const uncovered = names.filter((s) => !covered.has(s)).sort()
  const missing = currentSchemas(c).filter((s) => !names.includes(s)).sort()
  if (uncovered.length) return { ok: false, reason: 'uncovered_schema', uncovered, missing }
  if (missing.length) return { ok: false, reason: 'approved_schema_missing', uncovered, missing }
  return { ok: true, uncovered, missing }
}

export function bundleScope(c) { return { contract: c.contract, version: c.current_version, schemas: currentSchemas(c) } }

export function resolveBundle(c, scopeText) {
  if (scopeText === null) {
    const v1 = c.versions['1']
    return { ok: true, version: 1, coverage: v1.coverage, schemas: [...v1.schemas], historical: true }
  }
  let s
  try { s = JSON.parse(scopeText) } catch { return { ok: false, reason: 'scope_json_invalid' } }
  if (!s || s.contract !== c.contract) return { ok: false, reason: 'scope_contract_mismatch' }
  const ver = c.versions[String(s.version)]
  if (!Number.isInteger(s.version) || !ver) return { ok: false, reason: 'scope_version_unknown' }
  if (!Array.isArray(s.schemas) || s.schemas.join(',') !== ver.schemas.join(',')) return { ok: false, reason: 'scope_schemas_not_reviewed' }
  if (Object.keys(s).sort().join(',') !== 'contract,schemas,version') return { ok: false, reason: 'scope_unexpected_fields' }
  return { ok: true, version: s.version, coverage: ver.coverage, schemas: [...ver.schemas], historical: false }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, arg] = process.argv.slice(2)
  const c = loadContract()
  if (cmd === 'schemas') { process.stdout.write(currentSchemas(c).join(',')); process.exit(0) }
  if (cmd === 'check-discovered') {
    const r = checkDiscovered(c, readFileSync(arg, 'utf8').split(/\r?\n/))
    console.log(`M4_SCOPE discovery=${r.ok ? 'PASS' : 'FAIL'} reason=${r.reason ?? 'none'} uncovered=${(r.uncovered ?? []).join(',') || 'none'} missing=${(r.missing ?? []).join(',') || 'none'}`)
    process.exit(r.ok ? 0 : 1)
  }
  if (cmd === 'runtime-roles') { process.stdout.write(Object.keys(runtimeRoles(c, arg ?? c.current_version)).join(',')); process.exit(0) }
  if (cmd === 'check-runtime-roles') {
    const file = process.argv[4]
    const r = checkRuntimeRoles(c, arg, readFileSync(file, 'utf8').split(/\r?\n/))
    console.log(`M4_SCOPE runtime_roles=${r.ok ? 'PASS' : 'FAIL'} reason=${r.reason ?? 'none'}${r.role ? ` role=${r.role}` : ''}`)
    process.exit(r.ok ? 0 : 1)
  }
  if (cmd === 'platform-roles') { process.stdout.write(platformRoles(c, arg ?? c.current_version).join(',')); process.exit(0) }
  if (cmd === 'role-settings') { process.stdout.write(JSON.stringify(roleSettingsAllow(c, arg ?? c.current_version))); process.exit(0) }
  if (cmd === 'check-roles-file') {
    const q = checkRolesFile(c, arg, readFileSync(process.argv[4], 'utf8').split(/\r?\n/))
    console.log(`M4_SCOPE roles_file=${q.ok ? 'PASS' : 'FAIL'} reason=${q.reason ?? 'none'}${q.role ? ` role=${q.role}` : ''}${q.setting ? ` setting=${q.setting}` : ''}`)
    process.exit(q.ok ? 0 : 1)
  }
  if (cmd === 'check-roles') {
    const lines = readFileSync(process.argv[4], 'utf8').split(/\r?\n/)
    const r = checkRuntimeRoles(c, arg, lines)
    const q = r.ok ? checkRolesFile(c, arg, lines) : r
    console.log(`M4_SCOPE roles=${q.ok ? 'PASS' : 'FAIL'} reason=${q.reason ?? 'none'}${q.role ? ` role=${q.role}` : ''}${q.setting ? ` setting=${q.setting}` : ''}`)
    process.exit(q.ok ? 0 : 1)
  }
  if (cmd === 'write-bundle-scope') { writeFileSync(arg, JSON.stringify(bundleScope(c)) + '\n'); process.exit(0) }
  if (cmd === 'resolve-bundle') {
    const p = join(arg, 'scope.json')
    const r = resolveBundle(c, existsSync(p) ? readFileSync(p, 'utf8') : null)
    if (!r.ok) { console.log(`M4_SCOPE bundle=FAIL reason=${r.reason}`); process.exit(1) }
    console.log(`version=${r.version} coverage=${r.coverage} schemas=${r.schemas.join(',')}`)
    process.exit(0)
  }
  console.error('usage: backup-scope.mjs schemas|check-discovered <file>|write-bundle-scope <out>|resolve-bundle <dir>|runtime-roles [version]|check-runtime-roles <version> <roles.txt>|platform-roles [version]|role-settings [version]|check-roles <version> <roles.txt>|check-roles-file <version> <roles.txt>'); process.exit(2)
}
