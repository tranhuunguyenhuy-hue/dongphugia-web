// #511 per-step evidence for a release plan, read from the EXISTING lanes' runs on the exact candidate SHA (no orchestrator).
// SQL and function steps are identified by a run-name tag that each lane validates before acting:
//   [release plan=<id> step=<step> digest=<64 hex> env=<test|production> op=<apply|rollback|check|function>]
// Worker steps need no tag: one per plan, identified by the candidate SHA (fixed Staging publish-m3 / M4 publish).
// State of a step per environment = its NEWEST trusted run: success → applied (or rolled-back); failure, cancel or in progress →
// unknown, which blocks everything downstream until it is reconciled. Plan-check runs never change state.
import { DEFAULT_REPOSITORY, M4_WORKFLOW, SHA, STAGING_WORKFLOW, appendSummary, byTime, github, githubList, isMain } from './lib.mjs'
import { ancestors, loadPlan } from './plan.mjs'
import { lockStatus, validateUatIssue } from './staging-lock.mjs'

export const SQL_LANE = { test: '.github/workflows/m3-admin-api-deploy.yml', production: '.github/workflows/m6-production-sql-apply.yml' }
export const FUNCTION_LANE = { test: '.github/workflows/m3-admin-api-deploy.yml', production: '.github/workflows/m4-production-function-deploy.yml' }
export const STEP_NAMES = {
  apply: 'Apply the reviewed plan step', rollback: 'Roll back the reviewed plan step', check: 'Check the reviewed plan (read-only)',
  function: { test: 'Deploy function and set secrets (TEST project only)', production: 'Deploy function and set its secrets (Production only)' },
  worker: { test: 'Publish only named staging and run hosted smoke', production: 'Publish with the Admin secrets passed atomically' },
}
const TAG = /\[release plan=([a-z0-9][a-z0-9-]{2,60}) step=([a-z][a-z0-9-]{1,40}|\*) digest=([0-9a-f]{64}) env=(test|production) op=(apply|rollback|check|function)\]/

export function parseTag(title) {
  const m = String(title ?? '').match(TAG)
  return m ? { plan: m[1], step: m[2], digest: m[3], env: m[4], op: m[5] } : null
}

const trusted = (run, path, sha, repo) => run?.path === path && run.head_sha === sha && run.head_branch === 'main'
  && run.head_repository?.full_name === repo && run.event === 'workflow_dispatch'
const stepOk = (run, name, job) => (run.jobs ?? []).filter((j) => !job || j.name === job).flatMap((j) => j.steps ?? []).some((s) => s.name.startsWith(name) && s.conclusion === 'success')

/** Map stepId → { state, runId, at } for one environment. */
export function stepStates(loaded, environment, runs, { candidateSha, repo = DEFAULT_REPOSITORY }) {
  const events = []
  for (const run of runs ?? []) {
    const done = run.status === 'completed'
    const outcome = (ok, success) => (!done ? 'unknown' : run.conclusion === 'success' && ok ? success : 'unknown')
    const tag = parseTag(run.display_title ?? run.name)
    if (tag && tag.plan === loaded.plan.id && tag.digest === loaded.digest && tag.env === environment) {
      const step = loaded.plan.steps.find((s) => s.id === tag.step)
      if (!step) continue
      if (['apply', 'rollback'].includes(tag.op) && ['sql', 'backfill'].includes(step.type) && trusted(run, SQL_LANE[environment], candidateSha, repo)) {
        events.push({ step: step.id, state: outcome(stepOk(run, STEP_NAMES[tag.op]), tag.op === 'apply' ? 'applied' : 'rolled-back'), run })
      }
      if (tag.op === 'function' && step.type === 'function' && trusted(run, FUNCTION_LANE[environment], candidateSha, repo)) {
        events.push({ step: step.id, state: outcome(stepOk(run, STEP_NAMES.function[environment]), 'applied'), run })
      }
      continue
    }
    const worker = loaded.plan.steps.find((s) => s.type === 'worker')
    if (!worker) continue
    const path = environment === 'test' ? STAGING_WORKFLOW : M4_WORKFLOW
    if (run.path !== path || run.head_sha !== candidateSha || run.head_branch !== 'main' || run.head_repository?.full_name !== repo) continue
    if (!['workflow_dispatch', 'workflow_run'].includes(run.event)) continue
    const name = STEP_NAMES.worker[environment]
    const attempted = (run.jobs ?? []).flatMap((j) => j.steps ?? []).some((s) => s.name.startsWith(name) && s.conclusion !== 'skipped' && s.started_at)
    if (!attempted && done) continue // a verify-only or skipped run is not a Worker deployment
    events.push({ step: worker.id, state: outcome(stepOk(run, name, environment === 'test' ? 'publish-m3' : undefined), 'applied'), run })
  }
  const states = new Map(loaded.plan.steps.map((s) => [s.id, { state: 'none', runId: null, at: null }]))
  for (const e of events.sort((a, b) => byTime(a.run, b.run))) states.set(e.step, { state: e.state, runId: e.run.id, at: e.run.updated_at })
  return states
}

/** Successful read-only Production plan-check of this plan version, finished before `before`, not followed by a failed one. */
export function preflightOk(loaded, runs, runId, before, { candidateSha, repo = DEFAULT_REPOSITORY }) {
  const checks = (runs ?? []).filter((r) => trusted(r, SQL_LANE.production, candidateSha, repo))
    .filter((r) => { const t = parseTag(r.display_title ?? r.name); return t && t.op === 'check' && t.plan === loaded.plan.id && t.digest === loaded.digest && t.env === 'production' })
    .sort(byTime)
  const bound = checks.find((r) => String(r.id) === String(runId))
  if (!bound) return 'PREFLIGHT_RUN_NOT_A_PLAN_CHECK_OF_THIS_PLAN'
  if (!(bound.status === 'completed' && bound.conclusion === 'success' && stepOk(bound, STEP_NAMES.check))) return 'PREFLIGHT_RUN_NOT_PASSED'
  if (!(bound.updated_at < before)) return 'GO_BEFORE_PREFLIGHT_PASS'
  if (checks.some((r) => byTime(r, bound) > 0 && r.status === 'completed' && r.conclusion !== 'success')) return 'PREFLIGHT_INVALIDATED_BY_NEWER_FAILURE'
  return null
}

/**
 * Dependency gate for executing `target` in `environment` (target = a step id, or 'publish' for the Production Worker).
 * TEST: every ancestor applied in TEST. Production: the TEST chain up to and including the Worker (or the whole plan without a
 * Worker) applied in TEST, the step itself applied in TEST, and every ancestor applied in Production. Returns failure codes.
 */
export function dependencyGaps(loaded, environment, target, { testStates, prodStates }) {
  const gaps = []
  const plan = loaded.plan
  const worker = plan.steps.find((s) => s.type === 'worker')
  const stepId = target === 'publish' ? worker?.id : target
  if (target === 'publish' && !worker) return ['PLAN_HAS_NO_WORKER_STEP']
  if (!plan.steps.some((s) => s.id === stepId)) return [`PLAN_STEP_UNKNOWN:${stepId}`]
  const need = (states, ids, code) => { for (const id of ids) if (states.get(id)?.state !== 'applied') gaps.push(`${code}:${id}=${states.get(id)?.state ?? 'none'}`) }
  if (environment === 'test') { need(testStates, ancestors(plan, stepId), 'TEST_DEPENDENCY_NOT_APPLIED'); return gaps }
  const testChain = worker ? [...ancestors(plan, worker.id), worker.id] : plan.steps.map((s) => s.id)
  need(testStates, [...new Set([...testChain, stepId])], 'TEST_CHAIN_NOT_APPLIED')
  need(prodStates, ancestors(plan, stepId), 'PRODUCTION_DEPENDENCY_NOT_APPLIED')
  return gaps
}

const OP_TYPES = { apply: ['sql', 'backfill'], rollback: ['sql', 'backfill'], function: ['function'], worker: ['worker'], check: null }

/** Pure TEST-writer gate: plan identity, op/type match, TEST dependencies and the shared Staging/TEST UAT lock. */
export function evaluateTestGate({ loaded, expectedDigest, stepId, op, testStates, lock }) {
  const reasons = []
  if (loaded.digest !== expectedDigest) return ['PLAN_DIGEST_MISMATCH']
  if (op === 'check') return []
  const step = loaded.plan.steps.find((s) => s.id === stepId)
  if (!step) return [`PLAN_STEP_UNKNOWN:${stepId}`]
  if (!OP_TYPES[op]?.includes(step.type)) return [`PLAN_OP_DOES_NOT_MATCH_STEP:${op}/${step.type}`]
  if (op !== 'rollback') reasons.push(...dependencyGaps(loaded, 'test', step.id, { testStates }))
  if (!lock?.allowed) reasons.push(lock?.reason ?? 'LOCK_STATE_UNKNOWN') // shared TEST schema/function/Staging: never during another UAT
  return reasons
}

/** For Staging writers of a full-scope candidate: plan identity + TEST evidence up to the Worker (and the Worker, for lock-uat). */
export async function testChainForStaging({ request, repo, sha, planId, planDigest, includeWorker, categories, root = process.cwd() }) {
  if (!categories || !Object.keys(categories).length) return []
  if (!planId || !planDigest) return ['FULL_SCOPE_REQUIRES_PLAN_INPUTS']
  let loaded
  try { loaded = loadPlan(root, planId) } catch (error) { return [`PLAN_INVALID:${error.message}`] }
  if (loaded.digest !== planDigest) return ['PLAN_DIGEST_MISMATCH']
  const worker = loaded.plan.steps.find((s) => s.type === 'worker')
  if (!worker) return ['PLAN_HAS_NO_WORKER_STEP']
  const file = (p) => p.split('/').at(-1)
  const runsOf = async (p) => {
    const runs = await githubList(request, `/repos/${repo}/actions/workflows/${file(p)}/runs?head_sha=${sha}`, { key: 'workflow_runs', maxPages: 2 })
    return Promise.all(runs.map(async (r) => ({ ...r, jobs: (await request(`/repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`)).jobs })))
  }
  const runs = (await Promise.all([runsOf(SQL_LANE.test), runsOf(STAGING_WORKFLOW)])).flat().filter((r) => String(r.id) !== String(process.env.GITHUB_RUN_ID))
  const states = stepStates(loaded, 'test', runs, { candidateSha: sha, repo })
  const needed = [...ancestors(loaded.plan, worker.id), ...(includeWorker ? [worker.id] : [])]
  return needed.filter((id) => states.get(id)?.state !== 'applied').map((id) => `TEST_CHAIN_NOT_APPLIED:${id}=${states.get(id)?.state ?? 'none'}`)
}

async function main() {
  const [command] = process.argv.slice(2)
  if (command !== 'gate') throw new Error('USAGE: plan-evidence.mjs gate')
  const env = process.env
  const repo = env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY
  const sha = env.CANDIDATE_SHA
  if (!SHA.test(sha ?? '')) throw new Error('CANDIDATE_SHA_INVALID')
  if (env.RELEASE_ENV !== 'test') throw new Error('GATE_IS_FOR_TEST_WRITERS_PRODUCTION_USES_GO_EVIDENCE')
  const loaded = loadPlan(process.cwd(), env.PLAN_ID)
  const request = github()
  const file = (p) => p.split('/').at(-1)
  const runsOf = async (p) => {
    const runs = await githubList(request, `/repos/${repo}/actions/workflows/${file(p)}/runs?head_sha=${sha}`, { key: 'workflow_runs', maxPages: 2 })
    return Promise.all(runs.map(async (r) => ({ ...r, jobs: (await request(`/repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`)).jobs })))
  }
  const runs = (await Promise.all([runsOf(SQL_LANE.test), runsOf(STAGING_WORKFLOW)])).flat().filter((r) => String(r.id) !== String(env.GITHUB_RUN_ID))
  const testStates = stepStates(loaded, 'test', runs, { candidateSha: sha, repo })
  const issue = await validateUatIssue(request, env.UAT_ISSUE, repo).catch(() => { throw new Error('UAT_ISSUE_NOT_OPEN_ISSUE') })
  const lock = await lockStatus(request, { requestIssue: issue, candidateSha: sha, repo })
  const reasons = evaluateTestGate({ loaded, expectedDigest: env.PLAN_DIGEST, stepId: env.STEP_ID, op: env.PLAN_OP, testStates, lock })
  appendSummary(`- TEST plan gate \`${loaded.plan.id}/${env.STEP_ID}\` (${env.PLAN_OP}) digest \`${loaded.short}\`: **${reasons.length ? 'FAIL' : 'PASS'}**${reasons.length ? ` — ${reasons.join(', ')}` : ''} · TEST states: ${[...testStates].map(([k, v]) => `${k}=${v.state}`).join(', ')}`)
  console.error(`PLAN_GATE env=test status=${reasons.length ? 'FAIL' : 'PASS'}${reasons.length ? ` reasons=${reasons.join(',')}` : ''}`)
  if (reasons.length) process.exit(1)
}

if (isMain(import.meta.url)) main().catch((error) => { console.error(`PLAN_GATE status=FAIL reason=${error.message}`); process.exit(1) })
