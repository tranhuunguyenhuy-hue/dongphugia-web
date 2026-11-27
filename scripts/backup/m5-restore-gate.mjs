// Hard gate for the Production restore rehearsal (M5, extended by DPG-42). PASS only when pg_restore exited 0 with no error
// lines, every table's row count matches the source, and the schema object + ACL manifest matches exactly ("role" lines are
// inputs, not compared). Only the line kinds the source bundle recorded are compared, so historical v1 bundles stay
// restorable; a v2 bundle must carry the v2 kinds, per-table content digests and ownership, and all of them must match.
// Usage: node m5-restore-gate.mjs <pg_restore_exit> <restore.log> <expected-counts> <restored-counts> <expected-manifest> <restored-manifest>
//          [--scope-version <1|2>] [--content <expected> <restored>] [--owners <expected> <restored>] [--coverage <full|limited>]
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const lines = (text) => (text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
const kind = (line) => line.split(' ', 1)[0]
const V2_KINDS = ['object', 'acl', 'defs', 'schemaacl']

export function evaluateRestore({ exitCode, restoreLog, expectedCounts, restoredCounts, expectedManifest, restoredManifest,
  scopeVersion = 1, expectedContent, restoredContent, expectedOwners, restoredOwners }) {
  const failures = []
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
  }
  return { pass: failures.length === 0, failures, missing, extra, tables: expected.length, errorClasses: errorLines.slice(0, 12) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const [exit, log, ec, rc, em, rm] = args
  const opt = (name, n) => { const i = args.indexOf(name); return i < 0 ? undefined : args.slice(i + 1, i + 1 + n) }
  const read = (path) => readFileSync(path, 'utf8')
  const sv = Number(opt('--scope-version', 1)?.[0] ?? 1)
  const content = opt('--content', 2), owners = opt('--owners', 2), coverage = opt('--coverage', 1)?.[0] ?? (sv === 2 ? 'full' : 'limited')
  const result = evaluateRestore({ exitCode: Number(exit), restoreLog: read(log), expectedCounts: read(ec), restoredCounts: read(rc), expectedManifest: read(em), restoredManifest: read(rm),
    scopeVersion: sv, expectedContent: content && read(content[0]), restoredContent: content && read(content[1]), expectedOwners: owners && read(owners[0]), restoredOwners: owners && read(owners[1]) })
  for (const line of result.missing) console.log(`M4_RESTORE manifest_missing ${line}`)
  for (const line of result.extra) console.log(`M4_RESTORE manifest_extra ${line}`)
  for (const line of result.errorClasses) console.log(`M4_RESTORE error_line ${line.replace(/\s+/g, ' ').slice(0, 180)}`)
  console.log(`M4_RESTORE gate=${result.pass ? 'PASS' : 'FAIL'} scope_version=${sv} coverage=${coverage} tables=${result.tables} failures=${result.failures.join(',') || 'none'}`)
  process.exit(result.pass ? 0 : 1)
}
