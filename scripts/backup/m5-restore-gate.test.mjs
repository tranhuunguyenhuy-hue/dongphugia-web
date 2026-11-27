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

describe('DPG-42 scope v2 gate (commerce coverage)', () => {
  const v2m = 'object tables 3\nobject sequences 2\nacl dpg_admin_api table_SELECT 5\ndefs functions dpg_commerce abc\nschemaacl dpg_commerce dpg_backup_reader USAGE\nseq dpg_commerce.orders_id_seq\nrole dpg_admin_api\n'
  const c3 = 'dpg_app.products 2\ndpg_commerce.orders 2\ndpg_control.target_contract 1\n'
  const content = 'dpg_app.products 2 aa\ndpg_commerce.orders 2 bb\ndpg_control.target_contract 1 cc\n'
  const owners = 'owner function dpg_commerce_owner secdef dpg_commerce.order_submit(jsonb,text,text)\n'
  const ok2 = { exitCode: 0, restoreLog: '', expectedCounts: c3, restoredCounts: c3, expectedManifest: v2m, restoredManifest: v2m, scopeVersion: 2,
    expectedContent: content, restoredContent: content, expectedOwners: owners, restoredOwners: owners }
  it('passes an exact v2 restore', () => { expect(evaluateRestore(ok2)).toMatchObject({ pass: true, failures: [] }) })
  it('fails on content, owner or required-kind differences', () => {
    expect(evaluateRestore({ ...ok2, restoredContent: content.replace('bb', 'xx') }).failures).toContain('content_differs')
    expect(evaluateRestore({ ...ok2, restoredOwners: owners.replace('dpg_commerce_owner', 'postgres') }).failures).toContain('owners_differ')
    expect(evaluateRestore({ ...ok2, expectedContent: '' }).failures).toContain('content_missing')
    expect(evaluateRestore({ ...ok2, expectedOwners: '', restoredOwners: '' }).failures).toContain('owners_missing')
    const noDefs = v2m.replace(/^defs .*\n/m, '')
    expect(evaluateRestore({ ...ok2, expectedManifest: noDefs, restoredManifest: noDefs }).failures).toContain('manifest_missing_kind_defs')
    const noSeq = v2m.replace(/^seq .*\n/m, '')
    expect(evaluateRestore({ ...ok2, expectedManifest: noSeq, restoredManifest: noSeq }).failures).toContain('manifest_missing_kind_seq')
    expect(evaluateRestore({ ...ok2, expectedContent: content.replace('orders 2', 'orders 3'), restoredContent: content.replace('orders 2', 'orders 3') }).failures).toContain('content_counts_inconsistent')
    expect(evaluateRestore({ ...ok2, scopeVersion: 7 }).failures).toContain('scope_version_unknown_7')
  })
  it('compares only the kinds a historical v1 bundle recorded (restorable, not upgraded to full)', () => {
    const v1 = { ...ok, restoredManifest: manifest + 'defs functions dpg_app abc\nseq dpg_app.x_seq\n' }
    expect(evaluateRestore(v1)).toMatchObject({ pass: true })
    expect(evaluateRestore({ ...v1, restoredManifest: v1.restoredManifest.replace('object policies 188', 'object policies 187') }).failures).toContain('manifest_differs')
  })
})
