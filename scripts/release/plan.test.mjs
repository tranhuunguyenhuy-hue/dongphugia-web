// #511 Full Release Pipeline: plan validation, digest, coverage, per-step evidence, DAG gates and plan-mode GO (pure, no network).
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluateGo } from './go-evidence.mjs'
import { dependencyGaps, parseTag, preflightOk, stepStates } from './plan-evidence.mjs'
import { ancestors, coverageGaps, lintSql, loadPlan, validatePlanShape } from './plan.mjs'

const FIXTURE = 'scripts/release/fixtures/repo'
const ID = 'pilot-expand-backfill'
const REPO = 'tranhuunguyenhuy-hue/dongphugia-web'
const OWNER = 'tranhuunguyenhuy-hue'
const A = 'a'.repeat(40), B = 'b'.repeat(40)
const L = loadPlan(FIXTURE, ID)
const copy = (mutate) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dpg-plan-unit-'))
  cpSync(FIXTURE, root, { recursive: true })
  const dir = path.join(root, 'release/plans', ID)
  const plan = JSON.parse(readFileSync(path.join(dir, 'plan.json'), 'utf8'))
  mutate(plan, dir)
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan))
  return root
}

describe('#511 release plan manifest', () => {
  it('loads the pilot plan with a deterministic digest that changes with any SQL byte', () => {
    expect(L.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(loadPlan(FIXTURE, ID).digest).toBe(L.digest)
    const edited = copy((_p, dir) => writeFileSync(path.join(dir, '001-expand.sql'), `${readFileSync(path.join(dir, '001-expand.sql'), 'utf8')} `))
    expect(loadPlan(edited, ID).digest).not.toBe(L.digest)
    expect(ancestors(L.plan, 'worker')).toEqual(['expand', 'backfill', 'function'])
    expect(L.stepDigest('expand')).not.toBe(L.stepDigest('backfill'))
  })

  it.each([
    ['unknown key', (p) => { p.extra = 1 }, 'PLAN_KEY_UNKNOWN'],
    ['cycle', (p) => { p.steps[0].depends_on = ['backfill'] }, 'PLAN_DEPENDENCY_CYCLE'],
    ['unknown dependency', (p) => { p.steps[1].depends_on = ['nope'] }, 'PLAN_DEPENDENCY_UNKNOWN'],
    ['function not allowlisted', (p) => { p.steps[2].function = 'other' }, 'PLAN_FUNCTION_NOT_ALLOWED'],
    ['old Worker incompatible with new schema', (p) => { p.compatibility.old_worker_with_new_schema = false }, 'PLAN_INCOMPATIBLE_REQUIRES_MAINTENANCE_PLAN'],
    ['contract before the Worker', (p) => { p.steps[4].depends_on = []; p.steps[3].depends_on = ['function', 'contract'] }, 'PLAN_CONTRACT_BEFORE_WORKER'],
    ['covers a migration outside the plan', (p) => { p.covers = ['supabase/migrations/1.sql'] }, 'PLAN_COVERS_NOT_ALLOWED'],
    ['two Worker steps', (p) => { p.steps.push({ ...p.steps[3], id: 'worker-two' }) }, 'PLAN_MORE_THAN_ONE_WORKER_STEP'],
    ['bad rollback kind', (p) => { p.steps[3].rollback = { kind: 'sql', sql: '001-expand.rollback.sql' } }, 'PLAN_ROLLBACK_KIND_INVALID'],
    ['undeclared destructive contract', (p) => { delete p.steps[4].destructive }, 'PLAN_DESTRUCTIVE_NOT_DECLARED'],
    ['path traversal in a file name', (p) => { p.steps[0].sql = '../x.sql' }, 'PLAN_FILE_NAME_INVALID'],
  ])('refuses a plan with %s', (_n, mutate, code) => {
    expect(() => loadPlan(copy(mutate), ID)).toThrow(code)
  })

  it('refuses unreferenced files in the plan folder and a mismatching id', () => {
    expect(() => loadPlan(copy((_p, dir) => writeFileSync(path.join(dir, 'hidden.sql'), 'select 1')), ID)).toThrow('PLAN_FOLDER_HAS_UNREFERENCED_FILE')
    expect(() => loadPlan(copy((p) => { p.id = 'other-plan' }), ID)).toThrow('PLAN_ID_MISMATCH')
    expect(() => validatePlanShape({ schema: 2 })).toThrow()
  })

  it('lints SQL: no transaction control/CONCURRENTLY, declared destructive/privileged, read-only single-query checks', () => {
    const step = { id: 's' }
    expect(() => lintSql('alter table t add column c int;\ncommit;', 'apply', step)).toThrow('PLAN_SQL_TRANSACTION_CONTROL_OR_CONCURRENTLY')
    expect(() => lintSql('create index concurrently i on t (c);', 'apply', step)).toThrow('PLAN_SQL_TRANSACTION_CONTROL_OR_CONCURRENTLY')
    expect(() => lintSql('grant select on t to anon;', 'apply', step)).toThrow('PLAN_PRIVILEGED_NOT_DECLARED')
    expect(() => lintSql('alter table t enable row level security;', 'apply', step)).toThrow('PLAN_PRIVILEGED_NOT_DECLARED')
    expect(() => lintSql('delete from t where id = 1;', 'apply', step)).toThrow('PLAN_DESTRUCTIVE_NOT_DECLARED')
    expect(() => lintSql('alter table t alter column c type bigint;', 'apply', step)).toThrow('PLAN_DESTRUCTIVE_NOT_DECLARED')
    expect(() => lintSql('truncate t;', 'apply', { id: 's', destructive: true })).not.toThrow()
    expect(() => lintSql("-- drop table t\nalter table t add column note text default 'drop table x';", 'apply', step)).not.toThrow() // comments/strings ignored
    expect(() => lintSql('select 1 as ok; select 2', 'check', step)).toThrow('PLAN_CHECK_NOT_READ_ONLY_SINGLE_QUERY')
    expect(() => lintSql('with x as (delete from t returning 1) select true as ok', 'check', step)).toThrow('PLAN_CHECK_NOT_READ_ONLY_SINGLE_QUERY')
    expect(() => lintSql('update t set a = 1; update t set b = 2;', 'batch', step)).toThrow('PLAN_BATCH_NOT_SINGLE_STATEMENT')
  })

  it('coverage: every full-scope file must be in the plan folder or allowlisted covers, with the matching step type', () => {
    expect(coverageGaps(L, { sql: [`release/plans/${ID}/001-expand.sql`], function: ['supabase/functions/admin-api/index.ts'] })).toEqual([])
    expect(coverageGaps(L, { sql: ['supabase/migrations/20261201_x.sql'] })).toEqual(['sql:supabase/migrations/20261201_x.sql'])
    expect(coverageGaps(L, { function: ['supabase/functions/admin-api/other.ts'] })).toEqual(['function:supabase/functions/admin-api/other.ts'])
    expect(coverageGaps(L, { bindings: ['apps/public/wrangler.production.jsonc'] })).toEqual(expect.arrayContaining(['bindings:no-worker-step-with-bindings']))
    expect(coverageGaps(L, { sql: ['release/plans/another-plan/plan.json'] })).toEqual(['sql:release/plans/another-plan/plan.json']) // one plan per release
  })
})

// --- per-step evidence -----------------------------------------------------------------------------------------------------
let id = 1000
const tag = (step, op, env, digest = L.digest, plan = ID) => `[release plan=${plan} step=${step} digest=${digest} env=${env} op=${op}]`
const run = (pathName, title, created, over = {}, steps = {}) => ({
  id: id++, path: `.github/workflows/${pathName}`, display_title: title, head_sha: A, head_branch: 'main', head_repository: { full_name: REPO },
  event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: created, updated_at: created.replace(/:00Z$/, ':30Z'),
  jobs: [{ name: 'lane', steps: Object.entries(steps).map(([name, conclusion]) => ({ name, conclusion, started_at: created, completed_at: created.replace(/:00Z$/, ':20Z') })) }], ...over,
})
const testSql = (step, t, over, ok = 'success', op = 'apply') => run('m3-admin-api-deploy.yml', `M3 ${tag(step, op, 'test')}`, t, over, { [op === 'apply' ? 'Apply the reviewed plan step (TEST)' : 'Roll back the reviewed plan step (TEST)']: ok })
const testFn = (t) => run('m3-admin-api-deploy.yml', `M3 ${tag('function', 'function', 'test')}`, t, {}, { 'Deploy function and set secrets (TEST project only)': 'success' })
const staging = (t, sha = A) => ({ ...run('v1-fixed-preview.yml', 'M2 fixed Preview', t, { head_sha: sha, event: 'workflow_run' }), jobs: [{ name: 'publish-m3', steps: [{ name: 'Publish only named staging and run hosted smoke', conclusion: 'success', started_at: t, completed_at: t.replace(/:00Z$/, ':20Z') }] }] })
const prodSql = (step, t, over, ok = 'success', op = 'apply') => run('m6-production-sql-apply.yml', `M6 ${tag(step, op, 'production')}`, t, over, { [op === 'apply' ? 'Apply the reviewed plan step' : 'Roll back the reviewed plan step']: ok })
const prodFn = (t) => run('m4-production-function-deploy.yml', `M4 fn ${tag('function', 'function', 'production')}`, t, {}, { 'Deploy function and set its secrets (Production only)': 'success' })
const prodWorker = (t) => run('m4-production-admin-release.yml', 'M4 Production Admin release', t, {}, { 'Publish with the Admin secrets passed atomically': 'success' })
const preflight = (t, conclusion = 'success') => run('m6-production-sql-apply.yml', `M6 ${tag('*', 'check', 'production')}`, t, { conclusion }, { 'Check the reviewed plan (read-only)': conclusion })

const TEST_RUNS = [testSql('expand', '2026-12-01T09:00:00Z'), testSql('backfill', '2026-12-01T09:05:00Z'), testFn('2026-12-01T09:10:00Z'), staging('2026-12-01T09:20:00Z')]
const PREFLIGHT = preflight('2026-12-01T10:00:00Z')
const PROD_RUNS = [prodSql('expand', '2026-12-01T11:00:00Z'), prodSql('backfill', '2026-12-01T11:05:00Z'), prodFn('2026-12-01T11:10:00Z')]

describe('#511 per-step evidence and DAG gates', () => {
  it('parses lane tags and derives state from the newest trusted run', () => {
    expect(parseTag(`M6 plan-apply ${tag('expand', 'apply', 'production')}`)).toMatchObject({ plan: ID, step: 'expand', env: 'production', op: 'apply' })
    const t = stepStates(L, 'test', TEST_RUNS, { candidateSha: A })
    expect([...t].map(([k, v]) => `${k}=${v.state}`)).toEqual(['expand=applied', 'backfill=applied', 'function=applied', 'worker=applied', 'contract=none'])
  })

  it.each([
    ['untrusted event', { event: 'pull_request' }], ['another SHA', { head_sha: B }], ['a PR branch', { head_branch: 'feature' }],
  ])('ignores evidence from %s', (_n, over) => {
    expect(stepStates(L, 'test', [testSql('expand', '2026-12-01T09:00:00Z', over)], { candidateSha: A }).get('expand').state).toBe('none')
  })

  it('stale, rolled-back, failed or unrelated evidence never counts as applied', () => {
    const states = (runs) => stepStates(L, 'production', runs, { candidateSha: A })
    // Another plan version (digest) or another plan id: unrelated.
    expect(states([run('m6-production-sql-apply.yml', `M6 ${tag('expand', 'apply', 'production', 'f'.repeat(64))}`, '2026-12-01T11:00:00Z', {}, { 'Apply the reviewed plan step': 'success' })]).get('expand').state).toBe('none')
    // A successful rollback after the apply.
    expect(states([prodSql('expand', '2026-12-01T11:00:00Z'), prodSql('expand', '2026-12-01T12:00:00Z', {}, 'success', 'rollback')]).get('expand').state).toBe('rolled-back')
    // A failed re-apply (e.g. drift) after a success: unknown, blocks downstream.
    expect(states([prodSql('expand', '2026-12-01T11:00:00Z'), prodSql('expand', '2026-12-01T12:00:00Z', { conclusion: 'failure' }, 'failure')]).get('expand').state).toBe('unknown')
    // In progress.
    expect(states([prodSql('expand', '2026-12-01T11:00:00Z', { status: 'in_progress', conclusion: null })]).get('expand').state).toBe('unknown')
    // A check run or a run in the wrong lane never applies a step.
    expect(states([preflight('2026-12-01T10:00:00Z'), run('m3-admin-api-deploy.yml', `x ${tag('expand', 'apply', 'production')}`, '2026-12-01T11:00:00Z', {}, { 'Apply the reviewed plan step': 'success' })]).get('expand').state).toBe('none')
    // Wrong step type for the op (function op on an SQL step).
    expect(states([run('m4-production-function-deploy.yml', `x ${tag('expand', 'function', 'production')}`, '2026-12-01T11:00:00Z', {}, { 'Deploy function and set its secrets (Production only)': 'success' })]).get('expand').state).toBe('none')
    // A verify-only M4 run is not a Worker deployment.
    expect(states([run('m4-production-admin-release.yml', 'M4', '2026-12-01T11:00:00Z', {}, { 'Publish with the Admin secrets passed atomically': 'skipped' })]).get('worker').state).toBe('none')
  })

  it('gates each step on its dependencies: TEST ancestors in TEST; Production = TEST chain + Production ancestors', () => {
    const testStates = stepStates(L, 'test', TEST_RUNS, { candidateSha: A })
    const none = stepStates(L, 'production', [], { candidateSha: A })
    expect(dependencyGaps(L, 'test', 'backfill', { testStates: stepStates(L, 'test', [], { candidateSha: A }) })).toEqual(['TEST_DEPENDENCY_NOT_APPLIED:expand=none'])
    expect(dependencyGaps(L, 'production', 'expand', { testStates, prodStates: none })).toEqual([])
    expect(dependencyGaps(L, 'production', 'backfill', { testStates, prodStates: none })).toEqual(['PRODUCTION_DEPENDENCY_NOT_APPLIED:expand=none'])
    expect(dependencyGaps(L, 'production', 'publish', { testStates, prodStates: none })).toHaveLength(3)
    const partialTest = stepStates(L, 'test', TEST_RUNS.slice(0, 2), { candidateSha: A })
    expect(dependencyGaps(L, 'production', 'expand', { testStates: partialTest, prodStates: none })).toEqual(['TEST_CHAIN_NOT_APPLIED:function=none', 'TEST_CHAIN_NOT_APPLIED:worker=none'])
    expect(dependencyGaps(L, 'production', 'publish', { testStates, prodStates: stepStates(L, 'production', PROD_RUNS, { candidateSha: A }) })).toEqual([])
  })

  it('preflight: a passed read-only plan-check of this plan version, before the GO, not followed by a failure', () => {
    expect(preflightOk(L, [PREFLIGHT], PREFLIGHT.id, '2026-12-01T10:30:00Z', { candidateSha: A })).toBeNull()
    expect(preflightOk(L, [PREFLIGHT], PREFLIGHT.id, '2026-12-01T09:00:00Z', { candidateSha: A })).toBe('GO_BEFORE_PREFLIGHT_PASS')
    const failedLater = preflight('2026-12-01T10:10:00Z', 'failure')
    expect(preflightOk(L, [PREFLIGHT, failedLater], PREFLIGHT.id, '2026-12-01T10:30:00Z', { candidateSha: A })).toBe('PREFLIGHT_INVALIDATED_BY_NEWER_FAILURE')
    expect(preflightOk(L, [PROD_RUNS[0]], PROD_RUNS[0].id, '2026-12-01T12:00:00Z', { candidateSha: A })).toBe('PREFLIGHT_RUN_NOT_A_PLAN_CHECK_OF_THIS_PLAN')
  })
})

// --- plan-mode GO ----------------------------------------------------------------------------------------------------------
const GO_AT = '2026-12-01T10:40:00Z'
const comment = (body, created, over = {}) => ({ id: id++, body, created_at: created, updated_at: created, author_association: 'OWNER', user: { login: OWNER }, ...over })
const url = (cid) => `https://github.com/${REPO}/issues/700#issuecomment-${cid}`
const QUALITY = { id: 1, path: '.github/workflows/quality.yml', event: 'push', head_branch: 'main', head_sha: A, head_repository: { full_name: REPO }, status: 'completed', conclusion: 'success', created_at: '2026-12-01T08:00:00Z' }
const GO = `GO-PROD ${A}\nPLAN ${ID} ${L.digest}\nPREFLIGHT-RUN ${PREFLIGHT.id}\nLANE full\nUAT PASS ${A}`
const goInput = (body = GO, over = {}) => {
  const go = { ...comment(body, GO_AT), id: 9100, html_url: url(9100), issue_url: `https://api.github.com/repos/${REPO}/issues/700` }
  const testRuns = over.testRuns ?? TEST_RUNS
  const prodRuns = over.prodRuns ?? PROD_RUNS
  return {
    url: url(9100), comment: go, issue: { number: 700, state: 'open' }, issueComments: over.issueComments ?? [], m4Runs: [], stagingRuns: testRuns.filter((r) => r.path.endsWith('v1-fixed-preview.yml')),
    qualityRuns: [QUALITY], candidateSha: A, lane: 'full', fullTouch: { sql: B }, flagsChange: '', purpose: over.purpose ?? 'publish',
    plan: over.plan ?? { loaded: L, categories: over.categories ?? { sql: [`release/plans/${ID}/plan.json`], function: ['supabase/functions/admin-api/index.ts'] },
      sqlRuns: { production: [PREFLIGHT, ...prodRuns] }, testStates: stepStates(L, 'test', testRuns, { candidateSha: A }), prodStates: stepStates(L, 'production', prodRuns, { candidateSha: A }) },
  }
}

describe('#511 plan-mode GO (full scope)', () => {
  it('publishes the Worker step only with a valid plan, preflight, TEST chain before UAT and Production dependencies applied', () => {
    expect(evaluateGo(goInput())).toMatchObject({ ok: true, lane: 'full', uat: 'pass' })
  })

  it.each([
    ['no PLAN line', GO.replace(/PLAN [^\n]+\n/, ''), {}, 'FULL_SCOPE_REQUIRES_PLAN'],
    ['wrong digest', GO.replace(L.digest, 'e'.repeat(64)), {}, 'PLAN_DIGEST_MISMATCH'],
    ['plan failed validation', GO, { plan: { error: 'PLAN_INCOMPATIBLE_REQUIRES_MAINTENANCE_PLAN' } }, 'PLAN_INVALID:PLAN_INCOMPATIBLE_REQUIRES_MAINTENANCE_PLAN'],
    ['no preflight', GO.replace(/PREFLIGHT-RUN [^\n]+\n/, ''), {}, 'PREFLIGHT_RUN_MISSING'],
    ['uncovered migration in scope', GO, { categories: { sql: ['supabase/migrations/x.sql'] } }, 'PLAN_COVERAGE_GAP:sql:supabase/migrations/x.sql'],
    ['Production dependency missing', GO, { prodRuns: PROD_RUNS.slice(0, 1) }, 'PRODUCTION_DEPENDENCY_NOT_APPLIED:backfill=none'],
    ['Production step rolled back', GO, { prodRuns: [...PROD_RUNS, prodSql('backfill', '2026-12-01T11:30:00Z', {}, 'success', 'rollback')] }, 'PRODUCTION_DEPENDENCY_NOT_APPLIED:backfill=rolled-back'],
    ['partial failure (latest apply failed)', GO, { prodRuns: [...PROD_RUNS, prodSql('backfill', '2026-12-01T11:40:00Z', { conclusion: 'failure' }, 'failure')] }, 'PRODUCTION_DEPENDENCY_NOT_APPLIED:backfill=unknown'],
    ['TEST chain incomplete', GO, { testRuns: TEST_RUNS.slice(0, 3) }, 'TEST_CHAIN_NOT_APPLIED:worker=none'],
  ])('refuses: %s', (_n, body, over, reason) => {
    expect(evaluateGo(goInput(body, over)).reasons).toContain(reason)
  })

  it('UAT must follow the whole TEST chain (DB, function, combined Staging) on the exact candidate', () => {
    const uatFirst = [testSql('expand', '2026-12-01T09:00:00Z'), testSql('backfill', '2026-12-01T09:05:00Z'), staging('2026-12-01T09:20:00Z'), testFn('2026-12-01T10:45:00Z')]
    const r = evaluateGo(goInput(`GO-PROD ${A}\nPLAN ${ID} ${L.digest}\nPREFLIGHT-RUN ${PREFLIGHT.id}\nLANE full`, {
      testRuns: uatFirst, issueComments: [comment(`UAT PASS ${A}`, '2026-12-01T09:30:00Z')] }))
    expect(r.reasons).toContain('UAT_BEFORE_TEST_CHAIN_APPLIED')
  })

  it('destructive/privileged steps and SQL rollbacks need a SEPARATE unedited Owner approval after the GO', () => {
    const withWorker = [...PROD_RUNS, prodWorker('2026-12-01T11:20:00Z')]
    const contract = { purpose: { step: 'contract', op: 'apply' }, prodRuns: withWorker, testRuns: [...TEST_RUNS, testSql('contract', '2026-12-01T09:25:00Z')] }
    expect(evaluateGo(goInput(GO, contract)).reasons).toContain('STEP_GO_REQUIRED:contract')
    // The STEP-GO line inside the GO comment itself does not count (separate approval act).
    expect(evaluateGo(goInput(`${GO}\nSTEP-GO ${A} ${ID} contract`, contract)).reasons).toContain('STEP_GO_REQUIRED:contract')
    const separate = comment(`STEP-GO ${A} ${ID} contract`, '2026-12-01T11:25:00Z')
    expect(evaluateGo(goInput(GO, { ...contract, issueComments: [separate] })).ok).toBe(true)
    const edited = comment(`STEP-GO ${A} ${ID} contract`, '2026-12-01T11:25:00Z', { updated_at: '2026-12-01T11:26:00Z' })
    expect(evaluateGo(goInput(GO, { ...contract, issueComments: [edited] })).reasons).toContain('STEP_GO_REQUIRED:contract')
    // The contract step must itself have passed in TEST first.
    expect(evaluateGo(goInput(GO, { ...contract, testRuns: TEST_RUNS, issueComments: [separate] })).reasons).toContain('TEST_CHAIN_NOT_APPLIED:contract=none')
    // A Production SQL rollback needs ROLLBACK-GO.
    const rollback = { purpose: { step: 'expand', op: 'rollback' } }
    expect(evaluateGo(goInput(GO, rollback)).reasons).toContain('ROLLBACK_GO_REQUIRED:expand')
    expect(evaluateGo(goInput(GO, { ...rollback, issueComments: [comment(`ROLLBACK-GO ${A} ${ID} expand`, '2026-12-01T11:50:00Z')] })).reasons).not.toContain('ROLLBACK_GO_REQUIRED:expand')
  })

  it('a Production plan step needs the same GO (PLAN, preflight, UAT, quality) even when the Worker scope is unchanged', () => {
    const step = { purpose: { step: 'expand', op: 'apply' }, prodRuns: [] }
    expect(evaluateGo(goInput(GO, step)).ok).toBe(true)
    expect(evaluateGo({ ...goInput(GO, step), fullTouch: {} }).ok).toBe(true)
    expect(evaluateGo({ ...goInput(GO.replace(/PLAN [^\n]+\n/, ''), step), fullTouch: {} }).reasons).toContain('FULL_SCOPE_REQUIRES_PLAN')
    expect(evaluateGo({ ...goInput(GO, step), qualityRuns: [] }).reasons).toContain('QUALITY_NOT_PASSED state=missing')
  })
})
