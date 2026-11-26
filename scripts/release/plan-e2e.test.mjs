// #511 end-to-end pilot of the Full Release Pipeline on two isolated PostgreSQL databases (a TEST stand-in and a "Production"
// stand-in, both synthetic): TEST chain → UAT → read-only preflight → GO → Production steps in DAG order → Worker publish gate →
// contract with its separate approval. Lane runs are represented by the run records GitHub would return, built from each real
// executor result; every gate is the production code (evaluateGo / dependencyGaps / executeStep). Skipped without a database.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { evaluateGo } from './go-evidence.mjs'
import { dependencyGaps, stepStates } from './plan-evidence.mjs'
import { checkPlan, executeStep } from './plan-sql.mjs'
import { loadPlan } from './plan.mjs'

const ADMIN_URL = process.env.RELEASE_PLAN_TEST_DATABASE_URL || process.env.POSTGRES_SNAPSHOT_INTEGRATION_URL
const ROOT = 'scripts/release/fixtures/repo'
const ID = 'pilot-expand-backfill'
const REPO = 'tranhuunguyenhuy-hue/dongphugia-web'
const SHA = 'c'.repeat(40)
const dbs = []
const admin = async (sql) => { const c = new pg.Client({ connectionString: ADMIN_URL }); await c.connect(); try { return await c.query(sql) } finally { await c.end() } }
const urlOf = (name) => { const u = new URL(ADMIN_URL); u.pathname = `/${name}`; return u.toString() }
async function database(label) {
  const name = `dpg_e2e_${label}_${process.pid}_${Date.now()}`
  await admin(`create database ${name}`); dbs.push(name)
  const c = new pg.Client({ connectionString: urlOf(name) }); await c.connect()
  await c.query(readFileSync(path.join(ROOT, 'old-schema.sql'), 'utf8')); await c.end()
  return urlOf(name)
}
const q = async (url, sql) => { const c = new pg.Client({ connectionString: url }); await c.connect(); try { return (await c.query(sql)).rows } finally { await c.end() } }

// What GitHub would report for a lane run that executed `result` (success) or failed.
let clock = Date.parse('2026-12-02T08:00:00Z'), ids = 5000
const tick = () => { clock += 60000; return new Date(clock).toISOString().replace(/\.\d+Z$/, 'Z') }
const laneRun = (workflow, title, stepName, ok = true, job = 'lane') => {
  const t = tick()
  return { id: ids++, path: `.github/workflows/${workflow}`, display_title: title, head_sha: SHA, head_branch: 'main', head_repository: { full_name: REPO },
    event: 'workflow_dispatch', status: 'completed', conclusion: ok ? 'success' : 'failure', created_at: t, updated_at: t,
    jobs: [{ name: job, steps: [{ name: stepName, conclusion: ok ? 'success' : 'failure', started_at: t, completed_at: t }] }] }
}

describe.skipIf(!ADMIN_URL)('#511 end-to-end Full Release pilot (isolated databases, no Production)', () => {
  afterAll(async () => { for (const d of dbs) await admin(`drop database if exists ${d} with (force)`).catch(() => undefined) })

  it('runs TEST → UAT → preflight → GO → Production DAG → publish gate → contract, refusing every out-of-order or unapproved step', async () => {
    const L = loadPlan(ROOT, ID)
    const tag = (step, op, env) => `[release plan=${ID} step=${step} digest=${L.digest} env=${env} op=${op}]`
    const exec = (url, stepId, mode = 'apply') => executeStep({ root: ROOT, environment: 'ci', planId: ID, stepId, expectedDigest: L.digest, mode, databaseUrl: url, sourceSha: SHA, runId: String(ids) })
    const test = await database('test'), prod = await database('prod')
    const testRuns = [], prodRuns = []
    const states = () => ({ testStates: stepStates(L, 'test', testRuns, { candidateSha: SHA }), prodStates: stepStates(L, 'production', prodRuns, { candidateSha: SHA }) })

    // 1. TEST chain in DAG order; each lane run passes the TEST gate first.
    expect(dependencyGaps(L, 'test', 'backfill', states())).toEqual(['TEST_DEPENDENCY_NOT_APPLIED:expand=none'])
    for (const step of ['expand', 'backfill']) {
      expect(dependencyGaps(L, 'test', step, states())).toEqual([])
      expect((await exec(test, step)).result).toBe('applied')
      testRuns.push(laneRun('m3-admin-api-deploy.yml', `M3 TEST release-apply ${tag(step, 'apply', 'test')}`, 'Apply the reviewed plan step (TEST)'))
    }
    // Old Worker query keeps working on the expanded schema; the new Worker reads the backfilled column.
    expect(await q(test, 'select count(*)::int as n from (select id, name, price_vnd from dpg_app.products) old_worker')).toEqual([{ n: 5 }])
    expect(await q(test, "select price_label from dpg_app.products where name = 'Bồn cầu B'")).toEqual([{ price_label: 'Liên hệ báo giá' }])
    testRuns.push(laneRun('m3-admin-api-deploy.yml', `M3 TEST deploy ${tag('function', 'function', 'test')}`, 'Deploy function and set secrets (TEST project only)'))
    expect(dependencyGaps(L, 'test', 'worker', states())).toEqual([])
    testRuns.push({ ...laneRun('v1-fixed-preview.yml', `M2 fixed Preview ${tag('*', 'worker', 'test')}`, 'Publish only named staging and run hosted smoke', true, 'publish-m3') })
    expect(states().testStates.get('worker').state).toBe('applied')

    // 2. Owner UAT on the combined Staging, after the whole TEST chain.
    const uatAt = tick()
    // 3. Production read-only preflight: first step ready, dependent steps pending; nothing written.
    const pre = await checkPlan({ root: ROOT, environment: 'ci', planId: ID, expectedDigest: L.digest, databaseUrl: prod, sourceSha: SHA })
    expect(pre.steps).toEqual([{ step_id: 'expand', result: 'ready' }, { step_id: 'backfill', result: 'pending-dependency' }, { step_id: 'contract', result: 'pending-dependency' }])
    const preflight = laneRun('m6-production-sql-apply.yml', `M6 release-check ${tag('*', 'check', 'production')}`, 'Check the reviewed plan (read-only)')
    prodRuns.push(preflight)

    // 4. Owner GO bound to candidate + plan digest + preflight; UAT earlier.
    const goAt = tick()
    const go = { id: 9900, body: `GO-PROD ${SHA}\nPLAN ${ID} ${L.digest}\nPREFLIGHT-RUN ${preflight.id}\nLANE full`, created_at: goAt, updated_at: goAt,
      author_association: 'OWNER', user: { login: 'tranhuunguyenhuy-hue' }, html_url: `https://github.com/${REPO}/issues/711#issuecomment-9900`, issue_url: `https://api.github.com/repos/${REPO}/issues/711` }
    const uat = { id: 9899, body: `UAT PASS ${SHA}`, created_at: uatAt, updated_at: uatAt, author_association: 'OWNER', user: { login: 'tranhuunguyenhuy-hue' } }
    const quality = { id: 1, path: '.github/workflows/quality.yml', event: 'push', head_branch: 'main', head_sha: SHA, head_repository: { full_name: REPO }, status: 'completed', conclusion: 'success', created_at: '2026-12-02T07:00:00Z' }
    const extra = []
    const gate = (purpose) => evaluateGo({ url: go.html_url, comment: go, issue: { number: 711, state: 'open' }, issueComments: [uat, ...extra], m4Runs: [],
      stagingRuns: testRuns.filter((r) => r.path.endsWith('v1-fixed-preview.yml')), qualityRuns: [quality], candidateSha: SHA, lane: 'full', fullTouch: { sql: SHA },
      purpose, plan: { loaded: L, categories: { sql: [`release/plans/${ID}/plan.json`], function: ['supabase/functions/admin-api/index.ts'] }, sqlRuns: { production: prodRuns }, ...states() } })

    // 5. Production DAG: out of order refused by the gate AND by the executor; in order, each step applies once.
    expect(gate({ step: 'backfill', op: 'apply' }).reasons).toContain('PRODUCTION_DEPENDENCY_NOT_APPLIED:expand=none')
    await expect(exec(prod, 'backfill')).rejects.toThrow('PLAN_DEPENDENCY_NOT_APPLIED:expand')
    expect(gate('publish').reasons.filter((r) => r.startsWith('PRODUCTION_DEPENDENCY'))).toHaveLength(3) // no Worker before its dependencies
    for (const step of ['expand', 'backfill']) {
      expect(gate({ step, op: 'apply' })).toMatchObject({ ok: true })
      expect((await exec(prod, step)).result).toBe('applied')
      prodRuns.push(laneRun('m6-production-sql-apply.yml', `M6 release-apply ${tag(step, 'apply', 'production')}`, 'Apply the reviewed plan step'))
    }
    expect((await exec(prod, 'expand')).result).toBe('already-applied') // a blind re-run cannot apply twice
    expect(gate({ step: 'function', op: 'function' })).toMatchObject({ ok: true })
    prodRuns.push(laneRun('m4-production-function-deploy.yml', `M4 function deploy ${tag('function', 'function', 'production')}`, 'Deploy function and set its secrets (Production only)'))
    expect(gate('publish')).toMatchObject({ ok: true }) // the M4 publish may now run (it re-verifies the packaged Worker itself)
    prodRuns.push(laneRun('m4-production-admin-release.yml', `M4 Production Admin release ${tag('*', 'worker', 'production')}`, 'Publish with the Admin secrets passed atomically'))

    // 6. Contract: needs the TEST contract first and a SEPARATE STEP-GO; then the destructive change runs once.
    expect(gate({ step: 'contract', op: 'apply' }).reasons).toEqual(expect.arrayContaining(['TEST_CHAIN_NOT_APPLIED:contract=none', 'STEP_GO_REQUIRED:contract']))
    expect((await exec(test, 'contract')).result).toBe('applied')
    testRuns.push(laneRun('m3-admin-api-deploy.yml', `M3 TEST release-apply ${tag('contract', 'apply', 'test')}`, 'Apply the reviewed plan step (TEST)'))
    const stepGoAt = tick()
    extra.push({ id: 9901, body: `STEP-GO ${SHA} ${ID} contract`, created_at: stepGoAt, updated_at: stepGoAt, author_association: 'OWNER', user: { login: 'tranhuunguyenhuy-hue' } })
    expect(gate({ step: 'contract', op: 'apply' })).toMatchObject({ ok: true })
    expect((await exec(prod, 'contract')).result).toBe('applied')
    expect(await q(prod, "select count(*)::int as n from information_schema.columns where table_name = 'products' and column_name = 'legacy_note'")).toEqual([{ n: 0 }])

    // 7. Withdrawal after the fact: a later NO-GO blocks any further step (e.g. a rollback), and rollback needs ROLLBACK-GO.
    const rb = gate({ step: 'expand', op: 'rollback' })
    expect(rb.reasons).toContain('ROLLBACK_GO_REQUIRED:expand')
    extra.push({ id: 9902, body: `NO-GO ${SHA}`, created_at: tick(), updated_at: tick(), author_association: 'OWNER', user: { login: 'tranhuunguyenhuy-hue' } })
    expect(gate('publish').reasons).toContain('GO_REVOKED')
    const ledger = await q(prod, 'select step_id, status from dpg_release.step_ledger order by step_id')
    expect(ledger).toEqual([{ step_id: 'backfill', status: 'applied' }, { step_id: 'contract', status: 'applied' }, { step_id: 'expand', status: 'applied' }])
  })
})
