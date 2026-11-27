// Trusted backup scope for the Production backup lane (DPG-42). The allowlist is the reviewed file
// scripts/backup/backup-scope.json at the exact checked-out source; a bundle's scope.json is only data and is
// accepted only when it equals one reviewed version exactly. Bundles without scope.json are historical v1 (limited).
// Usage:
//   node backup-scope.mjs schemas                       -> current approved schemas, comma separated
//   node backup-scope.mjs check-discovered <file>       -> fail unless every discovered dpg_* schema with tables is in scope or excluded
//   node backup-scope.mjs write-bundle-scope <out>      -> write the bundle scope.json for the current version
//   node backup-scope.mjs resolve-bundle <bundle-dir>   -> print "version=<v> coverage=<full|limited> schemas=<a,b>"; exit 1 if untrusted
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
  return c
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
  if (cmd === 'write-bundle-scope') { writeFileSync(arg, JSON.stringify(bundleScope(c)) + '\n'); process.exit(0) }
  if (cmd === 'resolve-bundle') {
    const p = join(arg, 'scope.json')
    const r = resolveBundle(c, existsSync(p) ? readFileSync(p, 'utf8') : null)
    if (!r.ok) { console.log(`M4_SCOPE bundle=FAIL reason=${r.reason}`); process.exit(1) }
    console.log(`version=${r.version} coverage=${r.coverage} schemas=${r.schemas.join(',')}`)
    process.exit(0)
  }
  console.error('usage: backup-scope.mjs schemas|check-discovered <file>|write-bundle-scope <out>|resolve-bundle <dir>'); process.exit(2)
}
