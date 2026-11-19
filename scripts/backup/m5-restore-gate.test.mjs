import { describe, expect, it } from 'vitest'
import { evaluateRestore } from './m5-restore-gate.mjs'

const counts = 'dpg_app.products 17752\ndpg_app.brands 65\n'
const manifest = 'object tables 2\nobject policies 188\nacl dpg_admin_api table_SELECT 19\nrole dpg_admin_api\n'
const ok = { exitCode: 0, restoreLog: '', expectedCounts: counts, restoredCounts: counts, expectedManifest: manifest, restoredManifest: manifest }

describe('Production restore gate (M5)', () => {
  it('passes only an exact, error-free restore (role lines are not compared)', () => {
    expect(evaluateRestore(ok)).toMatchObject({ pass: true, failures: [], tables: 2 })
    expect(evaluateRestore({ ...ok, restoredManifest: manifest.replace('role dpg_admin_api\n', '') }).pass).toBe(true)
  })
  it('fails on a non-zero pg_restore exit even without error lines, and on error lines even with exit 0', () => {
    expect(evaluateRestore({ ...ok, exitCode: 1 }).failures).toContain('pg_restore_exit_1')
    expect(evaluateRestore({ ...ok, exitCode: Number.NaN }).pass).toBe(false)
    const log = 'pg_restore: error: could not execute query: ERROR:  role "x" does not exist\npg_restore: warning: errors ignored on restore: 1\n'
    expect(evaluateRestore({ ...ok, restoreLog: log }).failures).toContain('pg_restore_errors_2')
  })
  it('fails on any row-count or schema/ACL difference, naming the differing lines', () => {
    expect(evaluateRestore({ ...ok, restoredCounts: 'dpg_app.products 17751\ndpg_app.brands 65\n' }).failures).toContain('row_counts_differ')
    const fewer = evaluateRestore({ ...ok, restoredManifest: 'object tables 2\nobject policies 102\nacl dpg_admin_api table_SELECT 19\n' })
    expect(fewer.failures).toContain('manifest_differs')
    expect(fewer.missing).toEqual(['object policies 188']); expect(fewer.extra).toEqual(['object policies 102'])
    expect(evaluateRestore({ ...ok, restoredManifest: 'object tables 2\nobject policies 188\n' }).missing).toEqual(['acl dpg_admin_api table_SELECT 19'])
  })
  it('refuses an empty or ACL-less baseline instead of passing vacuously', () => {
    expect(evaluateRestore({ ...ok, expectedCounts: '', restoredCounts: '' }).failures).toContain('expected_counts_empty')
    expect(evaluateRestore({ ...ok, expectedManifest: 'object tables 2\n', restoredManifest: 'object tables 2\n' }).failures).toContain('manifest_missing_acl')
  })
})
