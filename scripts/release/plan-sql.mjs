// #511 generic SQL step executor for reviewed release plans (sql + backfill steps). Runs ONLY inside a protected lane:
// Production = M6 (`production-sql-apply` environment, operator credential, fresh backup proof, GO); TEST = the TEST lane.
// Inputs are ids + the expected plan digest; every SQL text comes from the plan folder at the checked-out SHA.
// FAIL CLOSED: digest/target/contract mismatch, precheck drift, postcheck failure, ledger conflict, missing dependency, a held
// lock or an incomplete backfill stop the step; a transaction rolls back everything it did. Never prints the credential.
//   env: DATABASE_URL · RELEASE_ENV (test|production|ci) · PLAN_ID · STEP_ID · PLAN_DIGEST · PLAN_MODE (check|apply|rollback)
//        GITHUB_SHA · GITHUB_RUN_ID · M6_BACKUP_EVIDENCE (production apply/rollback) · PLAN_OUT (evidence dir) · GITHUB_STEP_SUMMARY
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { assertBackupEvidence, assertProductionHost, loadAllowlist } from '../m6/lib.mjs'
import { appendSummary, isMain } from './lib.mjs'
import { PLANS_DIR, ancestors, loadPlan } from './plan.mjs'

const fail = (code, detail = '') => { throw new Error(detail ? `${code}:${detail}` : code) }
const LOCK = "hashtext('m6-production-sql-apply')" // same lock as the #470 M6 operations: never two writers on one database
const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]']

export function targetFor(environment, root = process.cwd()) {
  if (environment === 'production') {
    const list = loadAllowlist(path.join(root, 'scripts/m6/allowlist.json'))
    return { ref: list.target.project_ref, role: list.target.effective_role, minHeadroom: list.min_headroom_bytes, backup: list.backup,
      contract: { project_name: list.target.project_name, region: list.target.region, environment: list.target.environment, production_data_allowed: true, production_writes_allowed: true } }
  }
  if (environment === 'test') {
    return { ref: 'uybumsnyqpwcidjxmfsv', contract: { project_name: 'dongphugia-phase2-preview-290', region: 'ap-southeast-1', environment: 'preview_synthetic', production_data_allowed: false, production_writes_allowed: false } }
  }
  if (environment === 'ci') {
    return { loopback: true, contract: { project_name: 'dpg-release-ci', region: 'local', environment: 'ci_synthetic', production_data_allowed: false, production_writes_allowed: false } }
  }
  return fail('PLAN_ENVIRONMENT_NOT_ALLOWED', environment)
}

export function assertTargetUrl(databaseUrl, target) {
  let url; try { url = new URL(databaseUrl) } catch { fail('PLAN_DATABASE_URL_INVALID') }
  const loopback = LOOPBACK.includes(url.hostname)
  if (target.loopback) { if (!loopback) fail('PLAN_CI_TARGET_MUST_BE_LOOPBACK'); return }
  if (loopback) fail('PLAN_HOSTED_TARGET_ON_LOOPBACK')
  assertProductionHost(databaseUrl, target.ref) // generic "URL names this project ref" check
}

export function assertContract(row, target) {
  if (!row) fail('PLAN_TARGET_CONTRACT_MISSING')
  for (const [k, v] of Object.entries(target.contract)) if (row[k] !== v) fail('PLAN_TARGET_CONTRACT_MISMATCH', k)
}

const LEDGER_DDL = `create schema if not exists dpg_release;
create table if not exists dpg_release.step_ledger (
  plan_id text not null, step_id text not null, environment text not null,
  plan_digest text not null, step_digest text not null, source_sha text not null, run_id text,
  status text not null check (status in ('applied', 'rolled-back')), updated_at timestamptz not null default now(),
  primary key (plan_id, step_id))`

async function ledgerRows(client, planId) {
  const exists = (await client.query("select to_regclass('dpg_release.step_ledger') is not null as ok")).rows[0].ok
  if (!exists) return new Map()
  const rows = (await client.query('select step_id, status, step_digest, plan_digest, environment from dpg_release.step_ledger where plan_id = $1', [planId])).rows
  return new Map(rows.map((r) => [r.step_id, r]))
}

async function check(client, sql, label) {
  const result = await client.query(sql)
  const row = Array.isArray(result) ? result.at(-1).rows[0] : result.rows[0]
  if (!row || typeof row.ok !== 'boolean') fail('PLAN_CHECK_MUST_RETURN_OK_BOOLEAN', label)
  return row.ok
}
async function readOnly(client, fn) {
  await client.query('begin read only')
  try { return await fn() } finally { await client.query('rollback') }
}
async function txn(client, timeoutS, fn) {
  await client.query('begin')
  try {
    await client.query(`set local statement_timeout = '${timeoutS}s'`)
    await client.query("set local lock_timeout = '5s'")
    const out = await fn()
    await client.query('commit')
    return out
  } catch (error) { await client.query('rollback').catch(() => undefined); throw error }
}

/** Execute one plan step. Returns an evidence object (also written to PLAN_OUT/evidence.json by main()). */
export async function executeStep({ root, environment, planId, stepId, expectedDigest, mode, databaseUrl, sourceSha, runId, backupEvidence, now = new Date(), connect }) {
  if (!['check', 'apply', 'rollback'].includes(mode)) fail('PLAN_MODE_INVALID', mode)
  const target = targetFor(environment, root)
  const loaded = loadPlan(root, planId)
  if (environment === 'production' && loaded.plan.test_only) fail('PLAN_TEST_ONLY_NOT_FOR_PRODUCTION')
  if (loaded.digest !== expectedDigest) fail('PLAN_DIGEST_MISMATCH', loaded.short)
  const step = loaded.plan.steps.find((s) => s.id === stepId)
  if (!step) fail('PLAN_STEP_UNKNOWN', stepId)
  if (!['sql', 'backfill'].includes(step.type)) fail('PLAN_STEP_NOT_SQL', step.type)
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) fail('PLAN_SOURCE_SHA_INVALID')
  assertTargetUrl(databaseUrl, target)
  let backupAge = null
  if (environment === 'production' && mode !== 'check') backupAge = assertBackupEvidence(backupEvidence, target.backup, now)
  const dir = path.join(root, PLANS_DIR, planId)
  const file = (name) => readFileSync(path.join(dir, name), 'utf8')
  const stepDigest = loaded.stepDigest(step.id)
  const timeoutS = step.statement_timeout_s ?? 60
  const client = connect ? await connect(databaseUrl) : new pg.Client({ connectionString: databaseUrl, application_name: 'dpg-release-plan', statement_timeout: 120000 })
  if (!connect) await client.connect()
  const evidence = { schema: 1, environment, plan_id: planId, plan_digest: loaded.digest, step_id: step.id, step_type: step.type, step_digest: stepDigest,
    mode, source_sha: sourceSha, run_id: runId ?? null, backup_age_minutes: backupAge, result: 'UNKNOWN' }
  let locked = false
  try {
    if (target.role && (await client.query('select current_user as u')).rows[0].u !== target.role) await client.query(`set role "${target.role}"`)
    locked = (await client.query(`select pg_try_advisory_lock(${LOCK}) as ok`)).rows[0].ok
    if (!locked) fail('PLAN_ANOTHER_RUN_IN_PROGRESS')
    assertContract((await client.query('select project_name, region, environment, production_data_allowed, production_writes_allowed from dpg_control.target_contract limit 1').catch(() => ({ rows: [] }))).rows[0], target)
    if (target.minHeadroom && mode !== 'check') {
      const size = Number((await client.query('select pg_database_size(current_database()) as b')).rows[0].b)
      const ceiling = Number((await client.query('select hard_database_ceiling_bytes as c from dpg_control.target_contract limit 1')).rows[0].c)
      if (!(ceiling - size >= target.minHeadroom)) fail('PLAN_HEADROOM_BELOW_MINIMUM')
    }
    const ledger = await ledgerRows(client, planId)
    const row = ledger.get(step.id)
    if (row && row.environment !== environment) fail('PLAN_LEDGER_ENVIRONMENT_MISMATCH')
    const pre = () => readOnly(client, () => check(client, file(step.precheck), 'precheck'))
    const post = () => readOnly(client, () => check(client, file(step.postcheck), 'postcheck'))
    const upsert = (status) => client.query(`insert into dpg_release.step_ledger (plan_id, step_id, environment, plan_digest, step_digest, source_sha, run_id, status)
      values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (plan_id, step_id) do update set plan_digest = excluded.plan_digest, step_digest = excluded.step_digest,
      source_sha = excluded.source_sha, run_id = excluded.run_id, status = excluded.status, updated_at = now()`,
    [planId, step.id, environment, loaded.digest, stepDigest, sourceSha, runId ?? null, status])

    if (mode === 'check') {
      Object.assign(evidence, { ledger: row?.status ?? 'none', ledger_digest_matches: row ? row.step_digest === stepDigest : null, precheck: await pre(), postcheck: await post() })
      evidence.result = row?.status === 'applied' ? (evidence.ledger_digest_matches && evidence.postcheck ? 'applied' : 'drift') : evidence.precheck ? 'ready' : 'drift'
      return evidence
    }
    if (row && row.step_digest !== stepDigest) fail('PLAN_LEDGER_DIGEST_CONFLICT', `${step.id} recorded with another plan version`)

    if (mode === 'rollback') {
      if (step.rollback.kind !== 'sql') fail('PLAN_ROLLBACK_IS_FORWARD_FIX', step.id)
      if (row?.status !== 'applied') fail('PLAN_ROLLBACK_NOTHING_APPLIED', step.id)
      const dependents = loaded.plan.steps.filter((s) => ancestors(loaded.plan, s.id).includes(step.id)).map((s) => s.id)
      const applied = dependents.filter((id) => ledger.get(id)?.status === 'applied')
      if (applied.length) fail('PLAN_ROLLBACK_DEPENDENTS_STILL_APPLIED', applied.join(','))
      await txn(client, timeoutS, async () => {
        await client.query(file(step.rollback.sql))
        if (!(await check(client, file(step.precheck), 'precheck-after-rollback'))) fail('PLAN_ROLLBACK_POSTCONDITION_FAILED', step.id)
        await upsert('rolled-back')
      })
      evidence.result = 'rolled-back'
      return evidence
    }

    // apply: SQL dependencies must be applied in THIS database (authoritative); others are checked by the lane's evidence gate.
    for (const id of ancestors(loaded.plan, step.id)) {
      const dep = loaded.plan.steps.find((s) => s.id === id)
      if (['sql', 'backfill'].includes(dep.type) && ledger.get(id)?.status !== 'applied') fail('PLAN_DEPENDENCY_NOT_APPLIED', id)
    }
    if (row?.status === 'applied') {
      if (!(await post())) fail('PLAN_LEDGER_APPLIED_BUT_POSTCHECK_FAILS', step.id) // drift after apply: stop and reconcile
      evidence.result = 'already-applied'
      return evidence
    }
    if (!(await pre())) fail('PLAN_PRECHECK_FAILED_DRIFT', step.id)
    if (step.type === 'sql') {
      await txn(client, timeoutS, async () => {
        await client.query(LEDGER_DDL)
        await client.query(file(step.sql))
        if (!(await check(client, file(step.postcheck), 'postcheck'))) fail('PLAN_POSTCHECK_FAILED', step.id)
        await upsert('applied')
      })
    } else {
      let batches = 0, changed = 0, last = -1
      while (batches < step.max_batches) {
        last = await txn(client, timeoutS, async () => (await client.query(file(step.batch))).rowCount ?? 0)
        batches += 1; changed += last
        if (last === 0) break
      }
      evidence.batches = batches; evidence.rows_changed = changed
      if (last !== 0) fail('PLAN_BACKFILL_INCOMPLETE_RESUMABLE', `${batches} batches, ${changed} rows; run again to continue`)
      await txn(client, timeoutS, async () => {
        await client.query(LEDGER_DDL)
        if (!(await check(client, file(step.postcheck), 'postcheck'))) fail('PLAN_POSTCHECK_FAILED', step.id)
        await upsert('applied')
      })
    }
    evidence.result = 'applied'
    return evidence
  } finally {
    if (locked) await client.query(`select pg_advisory_unlock(${LOCK})`).catch(() => undefined)
    await client.end().catch(() => undefined)
  }
}

/** Read-only preflight of every SQL/backfill step in DAG order. A step whose SQL ancestors are not applied yet is
 *  `pending-dependency` (its precheck would describe a future state); any `drift` fails the whole check. */
export async function checkPlan(args) {
  const loaded = loadPlan(args.root, args.planId)
  if (args.environment === 'production' && loaded.plan.test_only) fail('PLAN_TEST_ONLY_NOT_FOR_PRODUCTION')
  const results = []
  for (const step of loaded.plan.steps.filter((s) => ['sql', 'backfill'].includes(s.type))) {
    const pending = ancestors(loaded.plan, step.id).filter((id) => ['sql', 'backfill'].includes(loaded.plan.steps.find((s) => s.id === id).type))
      .some((id) => results.find((r) => r.step_id === id)?.result !== 'applied')
    results.push(pending ? { step_id: step.id, result: 'pending-dependency' } : await executeStep({ ...args, stepId: step.id, mode: 'check' }))
  }
  const drift = results.filter((r) => r.result === 'drift').map((r) => r.step_id)
  if (drift.length) fail('PLAN_CHECK_DRIFT', drift.join(','))
  return { schema: 1, environment: args.environment, plan_id: loaded.plan.id, plan_digest: loaded.digest, step_id: '*', mode: 'check', result: 'checked',
    steps: results.map((r) => ({ step_id: r.step_id, result: r.result })) }
}

async function main() {
  const env = process.env
  const out = env.PLAN_OUT || path.join(process.cwd(), '.plan-out')
  mkdirSync(out, { recursive: true })
  const redact = (s) => String(s).replaceAll(env.DATABASE_URL || '\u0000', '<url>')
  try {
    const args = { root: process.cwd(), environment: env.RELEASE_ENV, planId: env.PLAN_ID, stepId: env.STEP_ID, expectedDigest: env.PLAN_DIGEST,
      mode: env.PLAN_MODE, databaseUrl: env.DATABASE_URL, sourceSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
      backupEvidence: env.M6_BACKUP_EVIDENCE ? JSON.parse(env.M6_BACKUP_EVIDENCE) : null }
    if (env.STEP_ID === '*' && env.PLAN_MODE !== 'check') fail('PLAN_ALL_STEPS_ONLY_FOR_CHECK')
    const evidence = env.STEP_ID === '*' ? await checkPlan(args) : await executeStep(args)
    if (evidence.steps) appendSummary(evidence.steps.map((r) => `  - \`${r.step_id}\`: ${r.result}`).join('\n'))
    writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
    appendSummary(`- Plan step \`${evidence.plan_id}/${evidence.step_id}\` (${evidence.environment}, ${evidence.mode}) digest \`${evidence.plan_digest.slice(0, 12)}\`: **${evidence.result}**`)
    console.error(`PLAN_STEP status=PASS env=${evidence.environment} plan=${evidence.plan_id} step=${evidence.step_id} result=${evidence.result}`)
  } catch (error) {
    const reason = redact(error.message).split('\n')[0].slice(0, 300)
    writeFileSync(path.join(out, 'evidence.json'), JSON.stringify({ schema: 1, environment: env.RELEASE_ENV, plan_id: env.PLAN_ID, step_id: env.STEP_ID, mode: env.PLAN_MODE, result: 'FAIL', reason }, null, 2) + '\n')
    appendSummary(`- Plan step \`${env.PLAN_ID}/${env.STEP_ID}\` (${env.RELEASE_ENV}, ${env.PLAN_MODE}): **FAIL** \`${reason}\` — nothing downstream may run; reconcile before any retry.`)
    console.error(`PLAN_STEP status=FAIL reason=${reason}`)
    process.exit(1)
  }
}

if (isMain(import.meta.url)) await main()
