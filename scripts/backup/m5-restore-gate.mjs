// Hard gate for the Production restore rehearsal (M5, extended by DPG-42). PASS only when pg_restore exited 0 with no error
// lines, every table's row count matches the source, and the schema object + ACL manifest matches exactly ("role" lines are
// inputs, not compared). Only the line kinds the source bundle recorded are compared, so historical v1 bundles stay
// restorable; a v2 bundle must carry the v2 kinds, per-table content digests and ownership, and all of them must match.
// Usage: node m5-restore-gate.mjs <pg_restore_exit> <restore.log> <expected-counts> <restored-counts> <expected-manifest> <restored-manifest>
//          [--scope-version <1|2>] [--content <e> <r>] [--owners <e> <r>] [--security <e> <r>] [--roles <e> <r>] [--coverage <full|limited>]
// Output is sanitized: differing lines are reported only as kind + object name (never values), and pg_restore errors only as
// fixed error classes (never the server text, which can contain row values).
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const lines = (text) => (text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
const kind = (line) => line.split(' ', 1)[0]
const V2_KINDS = ['object', 'acl', 'defs', 'schemaacl']
// fixed classes for pg_restore error lines; the raw text is never returned or printed
export function classify(errorLines) {
  const rules = [['permission_denied', /permission denied/i], ['missing_role', /role "[^"]*" does not exist/i], ['missing_object', /does not exist/i],
    ['duplicate_object', /already exists|duplicate key/i], ['constraint_violation', /violates|constraint/i], ['archive_error', /unexpected end of file|could not read|not a valid archive/i]]
  const counts = {}
  for (const line of errorLines) { const hit = rules.find(([, re]) => re.test(line)); const k = hit ? hit[0] : 'other_error'; counts[k] = (counts[k] ?? 0) + 1 }
  return Object.entries(counts).map(([k, n]) => `${k}=${n}`)
}
// "<kind> <object> ..." -> "<kind> <object>" only (no values, grantees or hashes)
const label = (line) => line.split(' ').slice(0, 2).join(' ')

export function evaluateRestore({ exitCode, restoreLog, expectedCounts, restoredCounts, expectedManifest, restoredManifest,
  scopeVersion = 1, expectedContent, restoredContent, expectedOwners, restoredOwners, expectedSecurity, restoredSecurity, expectedRoles, restoredRoles }) {
  const failures = [], securityDiff = []
  if (!Number.isInteger(exitCode) || exitCode !== 0) failures.push(`pg_restore_exit_${exitCode}`)
  const errorLines = lines(restoreLog).filter((line) => /^pg_restore: (error|warning: errors ignored)/.test(line))
  if (errorLines.length) failures.push(`pg_restore_errors_${errorLines.length}`)
  const expected = lines(expectedCounts).sort(), restored = lines(restoredCounts).sort()
  if (!expected.length) failures.push('expected_counts_empty')
  if (expected.join('\n') !== restored.join('\n')) failures.push('row_counts_differ')
  const source = lines(expectedManifest).filter((line) => kind(line) !== 'role')
  const kinds = new Set(source.map(kind))
  const expectedObjects = source.sort()
  const restoredObjects = lines(restoredManifest).filter((line) => kind(line) !== 'role' && kinds.has(kind(line))).sort()
  if (!expectedObjects.some((line) => line.startsWith('object tables '))) failures.push('manifest_missing_objects')
  if (!expectedObjects.some((line) => line.startsWith('acl '))) failures.push('manifest_missing_acl')
  const missing = expectedObjects.filter((line) => !restoredObjects.includes(line))
  const extra = restoredObjects.filter((line) => !expectedObjects.includes(line))
  if (missing.length || extra.length) failures.push('manifest_differs')
  if (scopeVersion !== 1 && scopeVersion !== 2) failures.push(`scope_version_unknown_${scopeVersion}`)
  if (scopeVersion === 2) {
    for (const k of V2_KINDS) if (!kinds.has(k)) failures.push(`manifest_missing_kind_${k}`)
    const seqObjects = expectedObjects.find((line) => line.startsWith('object sequences '))
    if (seqObjects && Number(seqObjects.split(' ')[2]) > 0 && !kinds.has('seq')) failures.push('manifest_missing_kind_seq')
    const ec = lines(expectedContent).sort(), rc = lines(restoredContent).sort()
    if (!ec.length) failures.push('content_missing')
    else if (ec.join('\n') !== rc.join('\n')) failures.push('content_differs')
    if (ec.length && ec.map((l) => l.split(' ').slice(0, 2).join(' ')).sort().join('\n') !== expected.join('\n')) failures.push('content_counts_inconsistent')
    const eo = lines(expectedOwners).sort(), ro = lines(restoredOwners).sort()
    if (!eo.length) failures.push('owners_missing')
    else if (eo.join('\n') !== ro.join('\n')) failures.push('owners_differ')
    const es = lines(expectedSecurity).sort(), rs = lines(restoredSecurity).sort()
    for (const k of ['tacl', 'nacl', 'rls', 'coldef']) if (!es.some((l) => kind(l) === k)) failures.push(`security_missing_kind_${k}`)
    if (es.join('\n') !== rs.join('\n')) failures.push('security_differs')
    securityDiff.push(...es.filter((l) => !rs.includes(l)), ...rs.filter((l) => !es.includes(l)))
    // provider-controlled edges (platform_edge) are exported with every grantor row but never replayed: they are verified against the
    // reviewed shapes by backup-scope.mjs check-roles, so they are excluded from the replay comparison on both sides
    const er = lines(expectedRoles).filter((l) => kind(l) !== 'platform_edge').sort(), rr = lines(restoredRoles).filter((l) => kind(l) !== 'platform_edge').sort()
    if (!er.some((l) => kind(l) === 'roleexists')) failures.push('roles_missing')
    else if (er.join('\n') !== rr.join('\n')) failures.push('roles_differ')
  }
  return { pass: failures.length === 0, failures, missing, extra, securityDiff, tables: expected.length, errorClasses: classify(errorLines) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const [exit, log, ec, rc, em, rm] = args
  const opt = (name, n) => { const i = args.indexOf(name); return i < 0 ? undefined : args.slice(i + 1, i + 1 + n) }
  const read = (path) => readFileSync(path, 'utf8')
  const sv = Number(opt('--scope-version', 1)?.[0] ?? 1)
  const content = opt('--content', 2), owners = opt('--owners', 2), security = opt('--security', 2), roles = opt('--roles', 2), coverage = opt('--coverage', 1)?.[0] ?? (sv === 2 ? 'full' : 'limited')
  const result = evaluateRestore({ exitCode: Number(exit), restoreLog: read(log), expectedCounts: read(ec), restoredCounts: read(rc), expectedManifest: read(em), restoredManifest: read(rm),
    scopeVersion: sv, expectedContent: content && read(content[0]), restoredContent: content && read(content[1]), expectedOwners: owners && read(owners[0]), restoredOwners: owners && read(owners[1]),
    expectedSecurity: security && read(security[0]), restoredSecurity: security && read(security[1]), expectedRoles: roles && read(roles[0]), restoredRoles: roles && read(roles[1]) })
  for (const line of new Set(result.missing.map(label))) console.log(`M4_RESTORE manifest_missing ${line}`)
  for (const line of new Set(result.extra.map(label))) console.log(`M4_RESTORE manifest_extra ${line}`)
  for (const line of new Set(result.securityDiff.map(label))) console.log(`M4_RESTORE security_differs ${line}`)
  for (const c of result.errorClasses) console.log(`M4_RESTORE error_class ${c}`)
  console.log(`M4_RESTORE gate=${result.pass ? 'PASS' : 'FAIL'} scope_version=${sv} coverage=${coverage} tables=${result.tables} failures=${result.failures.join(',') || 'none'}`)
  process.exit(result.pass ? 0 : 1)
}
