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
  for (const k of Object.keys(c.versions)) runtimeRoles(c, k)
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
  if (cmd === 'write-bundle-scope') { writeFileSync(arg, JSON.stringify(bundleScope(c)) + '\n'); process.exit(0) }
  if (cmd === 'resolve-bundle') {
    const p = join(arg, 'scope.json')
    const r = resolveBundle(c, existsSync(p) ? readFileSync(p, 'utf8') : null)
    if (!r.ok) { console.log(`M4_SCOPE bundle=FAIL reason=${r.reason}`); process.exit(1) }
    console.log(`version=${r.version} coverage=${r.coverage} schemas=${r.schemas.join(',')}`)
    process.exit(0)
  }
  console.error('usage: backup-scope.mjs schemas|check-discovered <file>|write-bundle-scope <out>|resolve-bundle <dir>|runtime-roles [version]|check-runtime-roles <version> <roles.txt>'); process.exit(2)
}
