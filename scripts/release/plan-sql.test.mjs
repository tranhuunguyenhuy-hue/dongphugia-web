// #511 integration tests of the generic SQL step executor against a REAL PostgreSQL (synthetic fixture, no Production data).
// CI: quality.yml provides POSTGRES_SNAPSHOT_INTEGRATION_URL (loopback service). Locally: RELEASE_PLAN_TEST_DATABASE_URL. Skipped otherwise.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { checkPlan, executeStep } from './plan-sql.mjs'
import { loadPlan } from './plan.mjs'

const ADMIN_URL = process.env.RELEASE_PLAN_TEST_DATABASE_URL || process.env.POSTGRES_SNAPSHOT_INTEGRATION_URL
const FIXTURE = 'scripts/release/fixtures/repo'
const PLAN = 'pilot-expand-backfill'
const SHA = 'a'.repeat(40)
const created = []

const dbUrl = (name) => { const u = new URL(ADMIN_URL); u.pathname = `/${name}`; return u.toString() }
async function admin(sql) { const c = new pg.Client({ connectionString: ADMIN_URL }); await c.connect(); try { return await c.query(sql) } finally { await c.end() } }
async function freshDb() {
  const name = `dpg_plan_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  await admin(`create database ${name}`)
  created.push(name)
  const c = new pg.Client({ connectionString: dbUrl(name) }); await c.connect()
  await c.query(readFileSync(path.join(FIXTURE, 'old-schema.sql'), 'utf8')); await c.end()
  return dbUrl(name)
}
async function q(url, sql) { const c = new pg.Client({ connectionString: url }); await c.connect(); try { return (await c.query(sql)).rows } finally { await c.end() } }
const copyFixture = (mutate) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dpg-plan-'))
  cpSync(FIXTURE, root, { recursive: true })
  mutate?.(path.join(root, 'release/plans', PLAN))
  return root
}

describe.skipIf(!ADMIN_URL)('#511 plan-sql executor on real PostgreSQL', () => {
  let url, digest
  const run = (stepId, mode = 'apply', over = {}) => executeStep({ root: FIXTURE, environment: 'ci', planId: PLAN, stepId, expectedDigest: digest, mode, databaseUrl: url, sourceSha: SHA, runId: '1', ...over })
  beforeEach(async () => { url = await freshDb(); digest = loadPlan(FIXTURE, PLAN).digest })
  afterAll(async () => { for (const name of created) await admin(`drop database if exists ${name} with (force)`).catch(() => undefined) })

  it('applies expand → backfill (batched, resumable) → records the ledger; re-apply is an idempotent no-op', async () => {
    expect((await run('expand', 'check')).result).toBe('ready') // read-only preflight: no ledger, precheck true, no writes
    expect(await q(url, "select to_regclass('dpg_release.step_ledger') as t")).toEqual([{ t: null }])
    expect((await run('expand')).result).toBe('applied')
    expect((await run('expand')).result).toBe('already-applied')
    // Backfill limited to 1 batch of 2 rows: incomplete, nothing recorded, then a rerun continues where it stopped.
    const fixture = copyFixture((dir) => {
      const plan = JSON.parse(readFileSync(path.join(dir, 'plan.json'), 'utf8')); plan.steps[1].max_batches = 1
      writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan))
    })
    const small = loadPlan(fixture, PLAN).digest
    // Only the backfill step changed in this plan version, so `expand` (same step content) stays applied; its 1-batch run is
    // incomplete and resumable, and the reviewed plan then finishes the job.
    await expect(executeStep({ root: fixture, environment: 'ci', planId: PLAN, stepId: 'backfill', expectedDigest: small, mode: 'apply', databaseUrl: url, sourceSha: SHA }))
      .rejects.toThrow(/PLAN_DEPENDENCY_NOT_APPLIED|PLAN_BACKFILL_INCOMPLETE_RESUMABLE/)
    const ev = await run('backfill')
    expect(ev).toMatchObject({ result: 'applied', step_type: 'backfill' })
    expect(await q(url, 'select count(*)::int as n from dpg_app.products where price_label is null')).toEqual([{ n: 0 }])
    expect(await q(url, "select name, price_label from dpg_app.products where id = 2")).toEqual([{ name: 'Bồn cầu B', price_label: 'Liên hệ báo giá' }])
    const ledger = await q(url, 'select step_id, status, environment, source_sha from dpg_release.step_ledger order by step_id')
    expect(ledger).toEqual([{ step_id: 'backfill', status: 'applied', environment: 'ci', source_sha: SHA }, { step_id: 'expand', status: 'applied', environment: 'ci', source_sha: SHA }])
  })

  it('resumes an interrupted backfill without redoing finished rows', async () => {
    await run('expand')
    const root = copyFixture((dir) => {
      const plan = JSON.parse(readFileSync(path.join(dir, 'plan.json'), 'utf8')); plan.steps[1].max_batches = 1
      writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan))
    })
    const d = loadPlan(root, PLAN).digest
    // Same step content in another plan version: already applied, not re-run.
    expect((await executeStep({ root, environment: 'ci', planId: PLAN, stepId: 'expand', expectedDigest: d, mode: 'apply', databaseUrl: url, sourceSha: SHA })).result).toBe('already-applied')
    // Changed SQL of an already-applied step: immutable ledger conflict, never a silent re-apply.
    const changed = copyFixture((dir) => writeFileSync(path.join(dir, '001-expand.sql'), 'alter table dpg_app.products add column price_label varchar(200);\n'))
    await expect(executeStep({ root: changed, environment: 'ci', planId: PLAN, stepId: 'expand', expectedDigest: loadPlan(changed, PLAN).digest, mode: 'apply', databaseUrl: url, sourceSha: SHA }))
      .rejects.toThrow('PLAN_LEDGER_DIGEST_CONFLICT')
    const url2 = await freshDb()
    const step = (stepId) => executeStep({ root, environment: 'ci', planId: PLAN, stepId, expectedDigest: d, mode: 'apply', databaseUrl: url2, sourceSha: SHA })
    await step('expand')
    await expect(step('backfill')).rejects.toThrow('PLAN_BACKFILL_INCOMPLETE_RESUMABLE')
    expect(await q(url2, 'select count(*)::int as n from dpg_app.products where price_label is not null')).toEqual([{ n: 2 }])
    await expect(step('backfill')).rejects.toThrow('PLAN_BACKFILL_INCOMPLETE_RESUMABLE')
    expect(await q(url2, 'select count(*)::int as n from dpg_app.products where price_label is not null')).toEqual([{ n: 4 }])
    expect((await step('backfill').catch(() => step('backfill'))).result).toBe('applied')
    expect(await q(url2, "select status from dpg_release.step_ledger where step_id = 'backfill'")).toEqual([{ status: 'applied' }])
  })

  it('read-only plan preflight: first steps checked, dependent steps pending, drift fails the whole check; nothing written', async () => {
    const all = (u) => checkPlan({ root: FIXTURE, environment: 'ci', planId: PLAN, expectedDigest: digest, databaseUrl: u, sourceSha: SHA })
    expect((await all(url)).steps).toEqual([
      { step_id: 'expand', result: 'ready' }, { step_id: 'backfill', result: 'pending-dependency' }, { step_id: 'contract', result: 'pending-dependency' }])
    expect(await q(url, "select to_regclass('dpg_release.step_ledger') as t")).toEqual([{ t: null }])
    await run('expand')
    expect((await all(url)).steps.map((s) => s.result)).toEqual(['applied', 'ready', 'pending-dependency'])
    await q(url, 'alter table dpg_app.products drop column price_label') // drift after apply
    await expect(all(url)).rejects.toThrow('PLAN_CHECK_DRIFT:expand')
  })

  it('fails closed: wrong digest, missing dependency, drift, unknown step, non-SQL step, held lock, wrong contract', async () => {
    await expect(run('expand', 'apply', { expectedDigest: 'f'.repeat(64) })).rejects.toThrow('PLAN_DIGEST_MISMATCH')
    await expect(run('backfill')).rejects.toThrow('PLAN_DEPENDENCY_NOT_APPLIED:expand')
    await expect(run('nope')).rejects.toThrow('PLAN_STEP_UNKNOWN')
    await expect(run('function')).rejects.toThrow('PLAN_STEP_NOT_SQL')
    await q(url, 'alter table dpg_app.products add column price_label text') // someone changed the schema out of band
    await expect(run('expand')).rejects.toThrow('PLAN_PRECHECK_FAILED_DRIFT')
    expect((await run('expand', 'check')).result).toBe('drift')
    const url2 = await freshDb()
    const holder = new pg.Client({ connectionString: url2 }); await holder.connect()
    await holder.query("select pg_advisory_lock(hashtext('m6-production-sql-apply'))")
    await expect(executeStep({ root: FIXTURE, environment: 'ci', planId: PLAN, stepId: 'expand', expectedDigest: digest, mode: 'apply', databaseUrl: url2, sourceSha: SHA })).rejects.toThrow('PLAN_ANOTHER_RUN_IN_PROGRESS')
    await holder.end()
    await q(url2, "update dpg_control.target_contract set environment = 'preview'")
    await expect(executeStep({ root: FIXTURE, environment: 'ci', planId: PLAN, stepId: 'expand', expectedDigest: digest, mode: 'apply', databaseUrl: url2, sourceSha: SHA })).rejects.toThrow('PLAN_TARGET_CONTRACT_MISMATCH:environment')
  })

  it('a failing postcheck or SQL error rolls the whole step back: no schema change, no ledger row', async () => {
    const badPost = copyFixture((dir) => writeFileSync(path.join(dir, '001-expand.post.sql'), "select false as ok\n"))
    await expect(executeStep({ root: badPost, environment: 'ci', planId: PLAN, stepId: 'expand', expectedDigest: loadPlan(badPost, PLAN).digest, mode: 'apply', databaseUrl: url, sourceSha: SHA }))
      .rejects.toThrow('PLAN_POSTCHECK_FAILED')
    expect(await q(url, "select count(*)::int as n from information_schema.columns where table_name = 'products' and column_name = 'price_label'")).toEqual([{ n: 0 }])
    expect(await q(url, "select to_regclass('dpg_release.step_ledger') as t")).toEqual([{ t: null }])
    const badSql = copyFixture((dir) => writeFileSync(path.join(dir, '001-expand.sql'), 'alter table dpg_app.products add column price_label text;\nalter table dpg_app.missing add column x int;\n'))
    await expect(executeStep({ root: badSql, environment: 'ci', planId: PLAN, stepId: 'expand', expectedDigest: loadPlan(badSql, PLAN).digest, mode: 'apply', databaseUrl: url, sourceSha: SHA })).rejects.toThrow()
    expect(await q(url, "select count(*)::int as n from information_schema.columns where table_name = 'products' and column_name = 'price_label'")).toEqual([{ n: 0 }])
  })

  it('rollback: only an applied step with an SQL rollback, never while a dependent step is applied; forward-fix steps refuse', async () => {
    await expect(run('expand', 'rollback')).rejects.toThrow('PLAN_ROLLBACK_NOTHING_APPLIED')
    await run('expand'); await run('backfill')
    await expect(run('expand', 'rollback')).rejects.toThrow('PLAN_ROLLBACK_DEPENDENTS_STILL_APPLIED:backfill')
    await expect(run('backfill', 'rollback')).rejects.toThrow('PLAN_ROLLBACK_IS_FORWARD_FIX')
    const url2 = await freshDb()
    const step = (id, mode) => executeStep({ root: FIXTURE, environment: 'ci', planId: PLAN, stepId: id, expectedDigest: digest, mode, databaseUrl: url2, sourceSha: SHA })
    await step('expand', 'apply')
    expect((await step('expand', 'rollback')).result).toBe('rolled-back')
    expect(await q(url2, "select status from dpg_release.step_ledger where step_id = 'expand'")).toEqual([{ status: 'rolled-back' }])
    expect((await step('expand', 'apply')).result).toBe('applied') // re-apply after a verified rollback (same plan version)
  })

  it('target guards: TEST/Production identities never run against loopback; Production mutations need fresh backup proof', async () => {
    await expect(run('expand', 'apply', { environment: 'test' })).rejects.toThrow('PLAN_HOSTED_TARGET_ON_LOOPBACK')
    await expect(run('expand', 'apply', { environment: 'staging' })).rejects.toThrow('PLAN_ENVIRONMENT_NOT_ALLOWED')
    const prodUrl = 'postgresql://postgres.bonxyxluzlxfkdetryoo:x@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres'
    const prod = (over) => executeStep({ root: FIXTURE, environment: 'production', planId: PLAN, stepId: 'expand', expectedDigest: digest, mode: 'apply', databaseUrl: prodUrl, sourceSha: SHA, ...over })
    await expect(prod({})).rejects.toThrow('M6_BACKUP_EVIDENCE_MISSING')
    const backup = { path: '.github/workflows/m4-production-backup.yml', head_branch: 'main', conclusion: 'success', updated_at: '2026-11-25T10:00:00Z',
      steps: { 'Row-count manifest, encrypted dump and checksums': true }, jobs: { 'restore-rehearsal': 'success' } }
    await expect(prod({ backupEvidence: backup, now: new Date('2026-11-25T13:00:00Z') })).rejects.toThrow('M6_BACKUP_TOO_OLD')
    await expect(prod({ backupEvidence: { ...backup, jobs: { 'restore-rehearsal': 'failure' } }, now: new Date('2026-11-25T10:30:00Z') })).rejects.toThrow('M6_BACKUP_RESTORE_NOT_PROVEN')
    await expect(prod({ databaseUrl: 'postgresql://postgres.uybumsnyqpwcidjxmfsv:x@aws-0.pooler.supabase.com:5432/postgres', backupEvidence: backup })).rejects.toThrow('M6_DATABASE_NOT_PRODUCTION_PROJECT')
  })
})
