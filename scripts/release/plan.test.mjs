// #511 Full Release Pipeline: plan validation, digest, coverage, per-step evidence, DAG gates and plan-mode GO (pure, no network).
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluateGo } from './go-evidence.mjs'
import { dependencyGaps, evaluateTestGate, parseTag, preflightOk, rollbackBlockers, stagingChainGaps, stepStates } from './plan-evidence.mjs'
import { ancestors, coverageGaps, lintSql, loadPlan, validatePlanShape } from './plan.mjs'
import { fullCategory } from './risk-lane.mjs'

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
const staging = (t, sha = A, title = `M2 fixed Preview ${tag('*', 'worker', 'test')}`) => ({ ...run('v1-fixed-preview.yml', title, t, { head_sha: sha }), jobs: [{ name: 'publish-m3', steps: [{ name: 'Publish only named staging and run hosted smoke', conclusion: 'success', started_at: t, completed_at: t.replace(/:00Z$/, ':20Z') }] }] })
const prodSql = (step, t, over, ok = 'success', op = 'apply') => run('m6-production-sql-apply.yml', `M6 ${tag(step, op, 'production')}`, t, over, { [op === 'apply' ? 'Apply the reviewed plan step' : 'Roll back the reviewed plan step']: ok })
const prodFn = (t) => run('m4-production-function-deploy.yml', `M4 fn ${tag('function', 'function', 'production')}`, t, {}, { 'Deploy function and set its secrets (Production only)': 'success' })
const prodWorker = (t, title = `M4 Production Admin release ${tag('*', 'worker', 'production')}`) => run('m4-production-admin-release.yml', title, t, {}, { 'Publish with the Admin secrets passed atomically': 'success' })
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
    expect(states([run('m4-production-admin-release.yml', `M4 ${tag('*', 'worker', 'production')}`, '2026-12-01T11:00:00Z', {}, { 'Publish with the Admin secrets passed atomically': 'skipped' })]).get('worker').state).toBe('none')
    // Worker evidence is bound to the plan and digest: an untagged publish, another plan or another digest of the SAME SHA never counts.
    for (const title of ['M4 Production Admin release', `M4 ${tag('*', 'worker', 'production', 'f'.repeat(64))}`, 'M4 [release plan=other-plan step=* digest=' + L.digest + ' env=production op=worker]']) {
      expect(states([prodWorker('2026-12-01T11:00:00Z', title)]).get('worker').state).toBe('none')
    }
    expect(states([prodWorker('2026-12-01T11:00:00Z')]).get('worker').state).toBe('applied')
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

  it('the dispatched operation must match the plan step type', () => {
    expect(evaluateGo(goInput(GO, { purpose: { step: 'function', op: 'apply' } })).reasons).toContain('PLAN_OP_DOES_NOT_MATCH_STEP:apply/function')
    expect(evaluateGo(goInput(GO, { purpose: { step: 'expand', op: 'function' } })).reasons).toContain('PLAN_OP_DOES_NOT_MATCH_STEP:function/sql')
    expect(evaluateGo(goInput(GO, { purpose: { step: 'nope', op: 'apply' } })).reasons).toContain('PLAN_OP_DOES_NOT_MATCH_STEP:apply/unknown')
  })

  it('a Production plan step needs the same GO (PLAN, preflight, UAT, quality) even when the Worker scope is unchanged', () => {
    const step = { purpose: { step: 'expand', op: 'apply' }, prodRuns: [] }
    expect(evaluateGo(goInput(GO, step)).ok).toBe(true)
    expect(evaluateGo({ ...goInput(GO, step), fullTouch: {} }).ok).toBe(true)
    expect(evaluateGo({ ...goInput(GO.replace(/PLAN [^\n]+\n/, ''), step), fullTouch: {} }).reasons).toContain('FULL_SCOPE_REQUIRES_PLAN')
    expect(evaluateGo({ ...goInput(GO, step), qualityRuns: [] }).reasons).toContain('QUALITY_NOT_PASSED state=missing')
  })
})

describe('#511 lane wiring (static)', () => {
  const read = (f) => readFileSync(`.github/workflows/${f}`, 'utf8')
  const m6 = read('m6-production-sql-apply.yml'), m3 = read('m3-admin-api-deploy.yml'), fn = read('m4-production-function-deploy.yml'), st = read('v1-fixed-preview.yml')
  it('every Production writer shares one concurrency group; TEST writers share the Staging group', () => {
    for (const wf of [m6, fn, read('m4-production-admin-release.yml')]) expect(wf).toContain('v1-production-worker-release')
    for (const wf of [m3, st]) expect(wf).toContain('group: m2-fixed-staging')
  })
  it('M6 plan steps: tagged run name, digest check, GO check and fresh backup before apply/rollback; read-only check has no GO', () => {
    expect(m6).toContain("[release plan={0} step={1} digest={2} env=production op={3}]")
    for (const name of ['Apply the reviewed plan step', 'Roll back the reviewed plan step', 'Check the reviewed plan (read-only)']) expect(m6).toContain(`- name: ${name}`)
    const order = ['Validate the reviewed release plan and its digest', 'Require the GO comment for this exact plan step', 'Verify the fresh backup evidence', 'Apply the reviewed plan step']
    const at = order.map((n) => m6.indexOf(n))
    expect(at.every((i) => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(m6).toContain("inputs.operation != 'release-check'") // backup proof skipped only for the read-only check
    expect(m6).toContain('if: "!startsWith(inputs.operation, \'release-\')"') // #470 lane script never runs for plan operations
  })
  it('TEST lane: plan SQL only on the TEST environment credential, gated by TEST dependencies and the UAT lock', () => {
    expect(m3).toContain('environment: m3-test-functions')
    expect(m3).toContain('DATABASE_URL: ${{ secrets.M3_TEST_SQL_DATABASE_URL }}')
    expect(m3).not.toContain('M6_OPERATOR_DATABASE_URL')
    expect(m3).toContain('node scripts/release/plan-evidence.mjs gate')
    expect(m3).toContain('MODE=manual node scripts/release/staging-lock.mjs recheck') // legacy function deploy still respects the lock
  })
  it('Production function lane: plan deploys pass the GO check and are tagged; Staging publish/lock-uat carry the plan', () => {
    expect(fn).toContain('op=function]')
    expect(fn.indexOf('Require the GO comment for this exact plan function step')).toBeLessThan(fn.indexOf('- name: Deploy function and set its secrets'))
    expect(st).toContain('STAGING_WRITER: worker')
    expect((st.match(/PLAN_DIGEST: \$\{\{ inputs\.plan_digest \}\}/g) ?? []).length).toBe(3)
  })
})

describe('#511 TEST writer under the UAT lock, and SQL rollback vs running runtime', () => {
  const applied = (...ids) => new Map(L.plan.steps.map((s) => [s.id, { state: ids.includes(s.id) ? 'applied' : 'none' }]))
  const gate = (op, step, testStates, lock) => evaluateTestGate({ loaded: L, expectedDigest: L.digest, stepId: step, op, testStates, lock })
  const held = { state: 'held', holder: 711, allowed: true, reason: 'LOCK_HELD_BY_REQUESTER_SAME_SHA' }
  const free = { state: 'free', allowed: true, reason: 'LOCK_FREE' }

  it('refuses a TEST write under a held lock even for the holder issue and same SHA; read-only check and a free lock pass', () => {
    expect(gate('apply', 'expand', applied(), held).join()).toMatch(/TEST_WRITE_REFUSED_UAT_LOCK_HELD issue=#711/)
    expect(gate('apply', 'expand', applied(), free)).toEqual([])
    expect(gate('check', '*', applied(), held)).toEqual([])
    expect(gate('apply', 'expand', applied(), { state: 'unknown', allowed: false, reason: 'LOCK_STATE_UNKNOWN' })).toEqual(['LOCK_STATE_UNKNOWN'])
  })

  it('blocks an SQL rollback while a dependent Function/Worker is applied or unknown (forward-fix), allows it when none is', () => {
    const workerStep = L.plan.steps.find((s) => s.type === 'worker')
    const dependsOnExpand = L.plan.steps.filter((s) => ['function', 'worker'].includes(s.type) && ancestors(L.plan, s.id).includes('expand')).map((s) => s.id)
    expect(dependsOnExpand.length).toBeGreaterThan(0)
    expect(rollbackBlockers(L, 'expand', applied())).toEqual([])
    expect(rollbackBlockers(L, 'expand', applied(workerStep.id)).join()).toMatch(/ROLLBACK_RUNTIME_DEPENDENT:/)
    const unknown = new Map([[workerStep.id, { state: 'unknown' }]])
    expect(rollbackBlockers(L, 'expand', unknown).join()).toMatch(/=unknown/)
    expect(gate('rollback', 'expand', applied(workerStep.id), free).join()).toMatch(/ROLLBACK_RUNTIME_DEPENDENT/)
  })
})

describe('#511 TEST-only pilot plan (the safe hosted read-only release-check on TEST)', () => {
  const real = loadPlan('.', 'test-readonly-probe')
  it('is valid, marked test_only, and its path is not Production full scope', () => {
    expect(real.plan.test_only).toBe(true)
    expect(real.plan.steps.map((s) => s.id)).toEqual(['probe'])
    expect(fullCategory('release/plans/test-readonly-probe/plan.json')).toBeNull()
    expect(fullCategory('release/plans/some-real-plan/plan.json')).toBe('sql')
  })
  it('requires the test- id and the mark to agree', () => {
    expect(() => loadPlan(copy((p) => { delete p.test_only }), ID)).not.toThrow() // real plan without mark stays valid
    expect(() => loadPlan(copy((p) => { p.test_only = true }), ID)).toThrow('PLAN_TEST_ONLY_MARK_MISMATCH')
  })
  it('is refused as a Production GO plan', () => {
    const r = evaluateGo({ url: 'https://github.com/tranhuunguyenhuy-hue/dongphugia-web/issues/1#issuecomment-1', comment: { id: 1, html_url: 'https://github.com/tranhuunguyenhuy-hue/dongphugia-web/issues/1#issuecomment-1', issue_url: 'https://api.github.com/repos/tranhuunguyenhuy-hue/dongphugia-web/issues/1', body: `GO-PROD ${'c'.repeat(40)}\nPLAN ${real.plan.id} ${real.digest}\nPREFLIGHT-RUN 1\nLANE full`, created_at: '2026-12-02T08:00:00Z', updated_at: '2026-12-02T08:00:00Z', author_association: 'OWNER', user: { login: 'tranhuunguyenhuy-hue' } },
      issue: { number: 1, state: 'open' }, issueComments: [], m4Runs: [], stagingRuns: [], qualityRuns: [], candidateSha: 'c'.repeat(40), lane: 'full', fullTouch: { sql: 'c'.repeat(40) },
      plan: { loaded: real, categories: { sql: [] }, sqlRuns: { production: [] }, testStates: new Map(), prodStates: new Map() } })
    expect(r.reasons).toContain('PLAN_TEST_ONLY_NOT_FOR_PRODUCTION')
  })
})

describe('#511 TL review fixes: DAG ordering, Worker binding, stale TEST writes, FLAGS-CHANGE on steps', () => {
  const planWith = (mutate) => { const p = JSON.parse(JSON.stringify(L.plan)); mutate(p); return p }
  it.each([
    ['disconnected function step', (p) => { p.steps[2].depends_on = []; p.steps[3].depends_on = ['backfill'] }, 'PLAN_STEP_NOT_ORDERED_AROUND_WORKER'],
    ['disconnected SQL step', (p) => { p.steps.push({ ...p.steps[0], id: 'extra', depends_on: [], sql: '001-expand.sql' }) }, 'PLAN_STEP_NOT_ORDERED_AROUND_WORKER'],
    ['independent destructive step', (p) => { p.steps[4].depends_on = []; p.steps[4].destructive = true }, 'PLAN_STEP_NOT_ORDERED_AROUND_WORKER'],
    ['destructive step that is a Worker ancestor', (p) => { p.steps[0].destructive = true }, 'PLAN_CONTRACT_BEFORE_WORKER'],
    ['destructive step without a Worker step', (p) => { p.steps = p.steps.filter((s) => s.type !== 'worker'); p.steps[3] = { ...p.steps[3], depends_on: ['backfill'] } }, 'PLAN_DESTRUCTIVE_REQUIRES_WORKER_STEP'],
  ])('refuses a plan with a %s', (_n, mutate, code) => expect(() => validatePlanShape(planWith(mutate))).toThrow(code))
  it('keeps the legitimate expand → backfill → function → worker → contract', () => expect(() => validatePlanShape(planWith(() => undefined))).not.toThrow())

  it('a Worker with bindings (and a destructive/privileged step) needs a SEPARATE STEP-GO on the publish too', () => {
    const bindingsPlan = { ...L, plan: planWith((p) => { p.steps[3].bindings = true }) }
    const input = goInput(GO, { plan: { loaded: bindingsPlan, categories: { sql: [`release/plans/${ID}/plan.json`], function: ['supabase/functions/admin-api/index.ts'], bindings: ['apps/public/wrangler.production.jsonc'] },
      sqlRuns: { production: [PREFLIGHT, ...PROD_RUNS] }, testStates: stepStates(L, 'test', TEST_RUNS, { candidateSha: A }), prodStates: stepStates(L, 'production', PROD_RUNS, { candidateSha: A }) } })
    expect(evaluateGo(input).reasons).toContain('STEP_GO_REQUIRED:worker')
    expect(evaluateGo({ ...input, issueComments: [comment(`STEP-GO ${A} ${ID} worker`, '2026-12-01T11:25:00Z')] }).reasons).not.toContain('STEP_GO_REQUIRED:worker')
  })

  it('Staging chain: plan coverage and TEST evidence are checked; a different plan/digest on the same SHA does not satisfy it', () => {
    const ok = stepStates(L, 'test', TEST_RUNS, { candidateSha: A })
    expect(stagingChainGaps(L, { sql: [`release/plans/${ID}/plan.json`] }, ok, true)).toEqual([])
    expect(stagingChainGaps(L, { sql: ['supabase/migrations/x.sql'] }, ok, true)).toEqual(['PLAN_COVERAGE_GAP:sql:supabase/migrations/x.sql'])
    const wrong = stepStates(L, 'test', [...TEST_RUNS.slice(0, 3), staging('2026-12-01T09:20:00Z', A, 'M2 fixed Preview')], { candidateSha: A })
    expect(stagingChainGaps(L, {}, wrong, true)).toEqual(['TEST_CHAIN_NOT_APPLIED:worker=none'])
    expect(stagingChainGaps(L, {}, wrong, false)).toEqual([]) // publish-m3 itself needs only the pre-Worker chain
  })

  it('first full publish-m3 combined with the lock is refused before any write (lock-uat is a separate run)', () => {
    expect(readFileSync('scripts/release/staging-lock.mjs', 'utf8')).toContain('FULL_SCOPE_PUBLISH_AND_LOCK_NOT_COMBINED')
  })

  it('TEST plan writes need the exact main HEAD (superseded and unknown refuse); read-only check is unaffected', () => {
    const g = (mainHead) => evaluateTestGate({ loaded: L, expectedDigest: L.digest, stepId: 'expand', op: 'apply', testStates: new Map(L.plan.steps.map((s) => [s.id, { state: 'none' }])), lock: { state: 'free', allowed: true }, mainHead, candidateSha: A })
    expect(g(A)).toEqual([])
    expect(g(B)).toEqual([`SUPERSEDED main=${B}`])
    expect(g('UNKNOWN')).toEqual(['SUPERSEDED main=UNKNOWN'])
    expect(evaluateTestGate({ loaded: L, expectedDigest: L.digest, stepId: '*', op: 'check', testStates: new Map(), lock: { state: 'held', allowed: true }, mainHead: B, candidateSha: A })).toEqual([])
  })

  it('a plan step does not reject a FLAGS-CHANGE line that the same GO carries for the later Worker publish', () => {
    const body = `${GO}\nFLAGS-CHANGE commerce=off`
    expect(evaluateGo(goInput(body, { purpose: { step: 'expand', op: 'apply' } })).reasons).not.toContain('FLAGS_CHANGE_STALE')
    expect(evaluateGo(goInput(body)).reasons).toContain('FLAGS_CHANGE_STALE') // the real live check stays at publish
  })

  it('the Worker publish dispatches carry the plan tag and the plan inputs', () => {
    expect(readFileSync('.github/workflows/v1-fixed-preview.yml', 'utf8')).toContain('env=test op=worker')
    const m4 = readFileSync('.github/workflows/m4-production-admin-release.yml', 'utf8')
    expect(m4).toContain('env=production op=worker')
    expect(m4.match(/PLAN_DIGEST: \$\{\{ inputs.plan_digest \}\}/g)).toHaveLength(2)
    expect(readFileSync('.github/workflows/m6-production-sql-apply.yml', 'utf8')).toContain('Recheck the GO comment and main HEAD immediately before the Production write')
  })
})
