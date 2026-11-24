import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { assertBackupEvidence, assertCapabilities, assertExpectedCounts, assertGo, assertHeadroom, assertPlanSetMatches, assertProductionHost, assertTarget, loadAllowlist, MUTATING, OPERATIONS, pinsFor, planSetSha, verifyPinned } from './lib.mjs'

const SHA = 'a'.repeat(40)
const list = loadAllowlist(path.join(process.cwd(), 'scripts/m6/allowlist.json'))
const code = (fn) => { try { fn(); return 'NO_ERROR' } catch (e) { return String(e.message).split(':')[0] } }
const NOW = new Date('2026-11-24T10:00:00Z')
const evidence = (over = {}) => ({ run_id: 1, path: list.backup.workflow, head_branch: 'main', conclusion: 'success', updated_at: '2026-11-24T09:00:00Z', steps: { [list.backup.backup_step]: true }, jobs: { [list.backup.restore_job]: 'success' }, ...over })

describe('#470 m6 Production SQL lane — fail-closed checks', () => {
  it('the allowlist is in sync with the files in the repository (drift = FAIL)', () => {
    expect(() => execFileSync('node', ['scripts/m6/build-allowlist.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
    expect(verifyPinned(process.cwd(), Object.values(list.sql).flat()).length).toBeGreaterThan(3)
  })
  it('only the fixed operation set exists and every mutating operation is in it', () => {
    for (const op of MUTATING) expect(OPERATIONS).toContain(op)
    expect(OPERATIONS).not.toContain('sql'); expect(OPERATIONS).not.toContain('psql')
    expect(code(() => assertGo({ operation: 'drop', approvedSha: SHA, githubSha: SHA }))).toBe('M6_OPERATION_NOT_ALLOWED')
  })
  it('refuses a wrong / short / non-main SHA and unknown groups; apply-import needs the approved plan-set hash', () => {
    expect(code(() => assertGo({ operation: 'apply-004', approvedSha: 'abc', githubSha: SHA }))).toBe('M6_APPROVED_SHA_INVALID')
    expect(code(() => assertGo({ operation: 'apply-004', approvedSha: 'b'.repeat(40), githubSha: SHA }))).toBe('M6_APPROVED_SHA_NOT_CURRENT_MAIN')
    expect(code(() => assertGo({ operation: 'plan-import', approvedSha: SHA, githubSha: SHA, group: 'x' }))).toBe('M6_GROUP_NOT_ALLOWED')
    expect(code(() => assertGo({ operation: 'apply-import', approvedSha: SHA, githubSha: SHA, group: 'prices' }))).toBe('M6_PLAN_SET_SHA_REQUIRED')
    expect(code(() => assertGo({ operation: 'apply-import', approvedSha: SHA, githubSha: SHA, group: 'prices', planSetSha256: '0'.repeat(64) }))).toBe('NO_ERROR')
  })
  it('backup evidence must be fresh (<2h), from main, successful, with a real dump and a passed restore rehearsal', () => {
    expect(assertBackupEvidence(evidence(), list.backup, NOW)).toBe(60)
    expect(code(() => assertBackupEvidence(null, list.backup, NOW))).toBe('M6_BACKUP_EVIDENCE_MISSING')
    expect(code(() => assertBackupEvidence(evidence({ path: '.github/workflows/runtime-backup.yml' }), list.backup, NOW))).toBe('M6_BACKUP_WRONG_WORKFLOW')
    expect(code(() => assertBackupEvidence(evidence({ head_branch: 'x' }), list.backup, NOW))).toBe('M6_BACKUP_NOT_FROM_MAIN')
    expect(code(() => assertBackupEvidence(evidence({ conclusion: 'failure' }), list.backup, NOW))).toBe('M6_BACKUP_NOT_SUCCESSFUL')
    expect(code(() => assertBackupEvidence(evidence({ steps: {} }), list.backup, NOW))).toBe('M6_BACKUP_DID_NOT_DUMP')
    expect(code(() => assertBackupEvidence(evidence({ jobs: { [list.backup.restore_job]: 'skipped' } }), list.backup, NOW))).toBe('M6_BACKUP_RESTORE_NOT_PROVEN')
    expect(code(() => assertBackupEvidence(evidence({ updated_at: '2026-11-24T07:59:00Z' }), list.backup, NOW))).toBe('M6_BACKUP_TOO_OLD')
    expect(code(() => assertBackupEvidence(evidence({ updated_at: '2026-11-24T10:30:00Z' }), list.backup, NOW))).toBe('M6_BACKUP_TIME_IN_FUTURE')
    expect(code(() => assertBackupEvidence(evidence({ updated_at: 'x' }), list.backup, NOW))).toBe('M6_BACKUP_TIME_UNKNOWN')
  })
  it('the target contract must be exactly the Production project and allow writes', () => {
    const contract = { project_name: 'dongphugia-runtime', region: 'ap-southeast-1', environment: 'preview', hard_database_ceiling_bytes: '367001600', production_data_allowed: true, production_writes_allowed: true }
    expect(code(() => assertTarget(contract, list.target))).toBe('NO_ERROR')
    expect(code(() => assertTarget({ ...contract, project_name: 'dongphugia-staging' }, list.target))).toBe('M6_TARGET_NOT_PRODUCTION_CONTRACT')
    expect(code(() => assertTarget({ ...contract, production_writes_allowed: false }, list.target))).toBe('M6_PRODUCTION_WRITES_NOT_ALLOWED')
    expect(code(() => assertTarget(undefined, list.target))).toBe('M6_TARGET_CONTRACT_MISSING')
  })
  it('the database URL must name the Production ref; headroom and operator capabilities are enforced', () => {
    const ref = list.target.project_ref
    expect(code(() => assertProductionHost(`postgresql://postgres.${ref}:x@aws-0.pooler.supabase.com:5432/postgres`, ref))).toBe('NO_ERROR')
    expect(code(() => assertProductionHost('postgresql://postgres.uybumsnyqpwcidjxmfsv:x@aws-0.pooler.supabase.com:5432/postgres', ref))).toBe('M6_DATABASE_NOT_PRODUCTION_PROJECT')
    expect(code(() => assertProductionHost('not a url', ref))).toBe('M6_DATABASE_URL_INVALID')
    expect(code(() => assertHeadroom(360e6, 367001600, 8 * 1048576))).toBe('M6_HEADROOM_BELOW_MINIMUM')
    expect(code(() => assertHeadroom(293336755, 367001600, 8 * 1048576))).toBe('NO_ERROR')
    expect(code(() => assertCapabilities({ effective_role: 'postgres', bypassrls: true, createrole: true }, 'postgres', 'apply-schema'))).toBe('NO_ERROR')
    expect(code(() => assertCapabilities({ effective_role: 'dpg_migration_login', bypassrls: false, createrole: false }, 'postgres', 'apply-004'))).toBe('M6_OPERATOR_ROLE_MISMATCH')
    expect(code(() => assertCapabilities({ effective_role: 'postgres', bypassrls: false, createrole: true }, 'postgres', 'apply-004'))).toBe('M6_OPERATOR_NEEDS_BYPASSRLS')
    expect(code(() => assertCapabilities({ effective_role: 'postgres', bypassrls: true, createrole: false }, 'postgres', 'apply-schema'))).toBe('M6_OPERATOR_NEEDS_CREATEROLE')
  })
  it('plan sets: approved row totals only, no stopped plan, an Owner-approved plan-set hash that changes with any plan', () => {
    const mk = (lane, mode, rows, plan_sha = lane, stop = []) => ({ lane, mode, rows, plan_sha, stop_reasons: stop })
    const prices = [...Array(9)].map((_, i) => mk(`p${i}`, i < 4 ? 'archived-direct' : i < 8 ? 'candidates' : 'baseline', i === 0 ? 4648 - 8 : 1)), status = [...Array(4)].map((_, i) => mk(`s${i}`, 'status', 321))
    expect(code(() => assertExpectedCounts('prices', [...prices, ...status], list.expected))).toBe('NO_ERROR')
    expect(code(() => assertExpectedCounts('prices', [...prices.slice(1), ...status], list.expected))).toBe('M6_PRICE_ROWS_NOT_APPROVED')
    expect(code(() => assertExpectedCounts('prices', [...prices.slice(0, 8), ...status], list.expected))).toBe('M6_PRICE_ROWS_NOT_APPROVED')
    expect(code(() => assertExpectedCounts('prices', [...prices, mk('x', 'status', 1, 'x', ['DRIFT'])], list.expected))).toBe('M6_PLAN_STOPPED')
    expect(code(() => assertExpectedCounts('voucher', [mk('v', 'voucher', 1101)], list.expected))).toBe('NO_ERROR')
    expect(code(() => assertExpectedCounts('voucher', [mk('v', 'voucher', 1102)], list.expected))).toBe('M6_VOUCHER_ROWS_NOT_APPROVED')
    const a = planSetSha([mk('a', 'status', 1, '1'), mk('b', 'status', 1, '2')]), b = planSetSha([mk('b', 'status', 1, '2'), mk('a', 'status', 1, '1')])
    expect(a).toBe(b); expect(planSetSha([mk('a', 'status', 1, '1'), mk('b', 'status', 1, '3')])).not.toBe(a)
    expect(code(() => assertPlanSetMatches(a, b))).toBe('NO_ERROR'); expect(code(() => assertPlanSetMatches(a, 'f'.repeat(64)))).toBe('M6_PLAN_SET_CHANGED')
  })
  it('a pinned file that differs by one byte (CRLF, whitespace) or escapes the repository is refused', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'm6-'))
    writeFileSync(path.join(dir, 'a.sql'), 'select 1;\n')
    const good = createHash('sha256').update('select 1;\n').digest('hex')
    expect(verifyPinned(dir, [{ file: 'a.sql', sha256: good }])).toEqual(['a.sql'])
    writeFileSync(path.join(dir, 'a.sql'), 'select 1;\r\n')
    expect(code(() => verifyPinned(dir, [{ file: 'a.sql', sha256: good }]))).toBe('M6_CHECKSUM_MISMATCH')
    expect(code(() => verifyPinned(dir, [{ file: '../etc/passwd', sha256: good }]))).toBe('M6_PATH_OUTSIDE_REPO')
    expect(code(() => verifyPinned(dir, [{ file: 'missing.sql', sha256: good }]))).toBe('M6_PINNED_FILE_MISSING')
  })
  it('pinsFor returns only allowlisted files per operation (lanes of the chosen group, never the other group)', () => {
    expect(pinsFor(list, 'apply-004').length).toBe(1)
    const prices = pinsFor(list, 'plan-import', 'prices').map((p) => p.file), voucher = pinsFor(list, 'plan-import', 'voucher').map((p) => p.file)
    expect(prices.some((f) => /voucher/.test(f) && !/scope-index/.test(f))).toBe(false)
    expect(voucher.length).toBeGreaterThan(2); expect(pinsFor(list, 'preflight')).toEqual([])
  })
  it('the workflow is manual-only on main for the Owner actor, takes no SQL/path input and keeps credentials out of the shell text', () => {
    const wf = readFileSync('.github/workflows/m6-production-sql-apply.yml', 'utf8')
    expect(wf).toMatch(/^on:\n  workflow_dispatch:/m); expect(wf).not.toMatch(/^\s+(push|pull_request|schedule|workflow_run):/m)
    expect(wf).toContain("github.ref == 'refs/heads/main'"); expect(wf).toContain("github.actor == 'tranhuunguyenhuy-hue'"); expect(wf).toContain('inputs.approved_source_sha == github.sha')
    expect(wf).toContain('environment: production-sql-apply')
    const inputs = [...wf.matchAll(/^      ([a-z_0-9]+):\n        description/gm)].map((m) => m[1])
    expect(inputs).toEqual(['approved_source_sha', 'operation', 'group', 'plan_set_sha256', 'resume', 'rollback_source_run_id', 'go_prod'])
    for (const name of inputs) expect(name).not.toMatch(/sql|path|file|url|query|command/)
    const choices = wf.match(/options: \[(preflight[^\]]*)\]/)[1].split(',').map((x) => x.trim())
    expect([...choices].sort()).toEqual([...OPERATIONS].sort())
    expect(wf).not.toMatch(/\$\{\{\s*inputs\.(go_prod|rollback_source_run_id|plan_set_sha256)\s*\}\}[^\n]*(run|test|\$\()/)
    expect(wf).not.toMatch(/echo "(?!::add-mask::)[^\n]*\$DATABASE_URL/)
  })
})
