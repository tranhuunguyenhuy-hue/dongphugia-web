// Hard gate for the Production restore rehearsal (M5). PASS only when pg_restore exited 0 with no error lines, every table's
// row count matches the source, and the schema object + ACL manifest matches exactly ("role" lines are inputs, not compared).
// Usage: node m5-restore-gate.mjs <pg_restore_exit> <restore.log> <expected-counts> <restored-counts> <expected-manifest> <restored-manifest>
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const lines = (text) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
const compared = (text) => lines(text).filter((line) => !line.startsWith('role ')).sort()

export function evaluateRestore({ exitCode, restoreLog, expectedCounts, restoredCounts, expectedManifest, restoredManifest }) {
  const failures = []
  if (!Number.isInteger(exitCode) || exitCode !== 0) failures.push(`pg_restore_exit_${exitCode}`)
  const errorLines = lines(restoreLog).filter((line) => /^pg_restore: (error|warning: errors ignored)/.test(line))
  if (errorLines.length) failures.push(`pg_restore_errors_${errorLines.length}`)
  const expected = lines(expectedCounts).sort(), restored = lines(restoredCounts).sort()
  if (!expected.length) failures.push('expected_counts_empty')
  if (expected.join('\n') !== restored.join('\n')) failures.push('row_counts_differ')
  const expectedObjects = compared(expectedManifest), restoredObjects = compared(restoredManifest)
  if (!expectedObjects.some((line) => line.startsWith('object tables '))) failures.push('manifest_missing_objects')
  if (!expectedObjects.some((line) => line.startsWith('acl '))) failures.push('manifest_missing_acl')
  const missing = expectedObjects.filter((line) => !restoredObjects.includes(line))
  const extra = restoredObjects.filter((line) => !expectedObjects.includes(line))
  if (missing.length || extra.length) failures.push('manifest_differs')
  return { pass: failures.length === 0, failures, missing, extra, tables: expected.length, errorClasses: errorLines.slice(0, 12) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [exit, log, ec, rc, em, rm] = process.argv.slice(2)
  const read = (path) => readFileSync(path, 'utf8')
  const result = evaluateRestore({ exitCode: Number(exit), restoreLog: read(log), expectedCounts: read(ec), restoredCounts: read(rc), expectedManifest: read(em), restoredManifest: read(rm) })
  for (const line of result.missing) console.log(`M4_RESTORE manifest_missing ${line}`)
  for (const line of result.extra) console.log(`M4_RESTORE manifest_extra ${line}`)
  for (const line of result.errorClasses) console.log(`M4_RESTORE error_line ${line.replace(/\s+/g, ' ').slice(0, 180)}`)
  console.log(`M4_RESTORE gate=${result.pass ? 'PASS' : 'FAIL'} tables=${result.tables} failures=${result.failures.join(',') || 'none'}`)
  process.exit(result.pass ? 0 : 1)
}
