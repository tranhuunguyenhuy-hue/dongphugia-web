// #505 D3-A: a Production publish requires a real GO-PROD comment for the exact candidate, bound to a trusted verify PASS.
// LIMIT: agents, Tech Lead and Owner share one GitHub login, so this blocks a MISSING, WRONG, STALE or REVOKED approval; it does NOT
// authenticate the Owner and is not an independent security boundary (option D3-B, separate identity, is deferred).
//
// Directives: whole lines starting at column 0, outside code (fenced or indented), quotes and HTML comments, in an Owner comment.
//   GO-PROD <sha>                        required, exactly one, in the GO comment
//   VERIFY-RUN <run id>                  required: the trusted verify PASS this approval is bound to (printed by the verify run)
//   LANE <fast|standard|extended|full>   required when the lane floor is extended/full; may raise, never lower
//   UAT PASS <sha>                       Owner UAT on fixed Staging (GO comment or an earlier Owner comment), required for fast+
//   UAT-WAIVER <sha> <reason>            explicit Owner deferral/waiver instead of UAT, only in the GO comment
//   FLAGS-CHANGE <key=value;...>         required exactly when the reviewed flags differ from the active version
//   PLAN <plan-id> <64-hex digest>       full scope (#511): the reviewed release plan this GO approves (one per release)
//   PREFLIGHT-RUN <run id>               full scope: the read-only Production plan-check run (M6 plan-check) passed before this GO
//   STEP-GO <sha> <plan-id> <step-id>    a destructive or privileged plan step: SEPARATE unedited Owner comment after the GO
//   ROLLBACK-GO <sha> <plan-id> <step-id>   an SQL rollback of a plan step: SEPARATE unedited Owner comment after the GO
//   NO-GO <sha> | GO-PROD-REVOKE <sha> | UAT FAIL <sha>   withdraw approval (also after the GO, up to the pre-deploy recheck);
//                                        withdrawals count even from an edited comment, approvals only from unedited ones
// Full scope (real SQL, Supabase function or Worker binding changes) is publishable only through a reviewed release PLAN (#511):
// the plan must cover every full-scope file, its TEST chain must be applied before the UAT, and every dependency of the step being
// executed must have trusted per-step evidence (plan-evidence.mjs) on this candidate and plan digest. Without a valid plan it fails
// closed (FULL_SCOPE_REQUIRES_PLAN).
import {
  DEFAULT_REPOSITORY, M4_WORKFLOW, QUALITY_WORKFLOW, SHA, STAGING_WORKFLOW, appendSummary, byTime, currentMainHead, github,
  githubList, isMain, isOwnerComment, plainLines, qualityFromRuns,
} from './lib.mjs'
import { FUNCTION_LANE, SQL_LANE, dependencyGaps, preflightOk, rollbackBlockers, stepStates } from './plan-evidence.mjs'
import { ancestors, coverageGaps, loadPlan } from './plan.mjs'
import { LANES, laneRank, maxLane, releaseScope } from './risk-lane.mjs'

const DIRECTIVE = [
  ['go', /^GO-PROD ([0-9a-f]{40})$/],
  ['revoke', /^GO-PROD-REVOKE ([0-9a-f]{40})$/],
  ['nogo', /^NO-GO ([0-9a-f]{40})$/],
  ['uatPass', /^UAT PASS ([0-9a-f]{40})$/],
  ['uatFail', /^UAT FAIL ([0-9a-f]{40})$/],
  ['waiver', /^UAT-WAIVER ([0-9a-f]{40}) (\S.{2,})$/],
  ['verifyRun', /^VERIFY-RUN ([1-9][0-9]*)$/],
  ['lane', new RegExp(`^LANE (${LANES.filter((l) => l !== 'none').join('|')})$`)],
  ['flags', /^FLAGS-CHANGE ([a-z_]+=[a-z,-]+(?:;[a-z_]+=[a-z,-]+)*)$/],
  ['plan', /^PLAN ([a-z0-9][a-z0-9-]{2,60}) ([0-9a-f]{64})$/],
  ['preflightRun', /^PREFLIGHT-RUN ([1-9][0-9]*)$/],
  ['stepGo', /^STEP-GO ([0-9a-f]{40}) ([a-z0-9][a-z0-9-]{2,60}) ([a-z][a-z0-9-]{1,40})$/],
  ['rollbackGo', /^ROLLBACK-GO ([0-9a-f]{40}) ([a-z0-9][a-z0-9-]{2,60}) ([a-z][a-z0-9-]{1,40})$/],
]

export function parseDirectives(body) {
  const found = []
  for (const line of plainLines(body)) {
    for (const [type, re] of DIRECTIVE) {
      const m = line.match(re)
      if (m) found.push({ type, value: m[1], extra: m[2], args: m.slice(1) })
    }
  }
  return found
}

const COMMENT_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)#issuecomment-(\d+)$/
export function parseCommentUrl(url, repo = DEFAULT_REPOSITORY) {
  const m = String(url ?? '').match(COMMENT_URL)
  if (!m) throw new Error('GO_URL_INVALID')
  if (m[1] !== repo) throw new Error('GO_URL_WRONG_REPOSITORY')
  return { issue: Number(m[2]), commentId: Number(m[3]) }
}

const unedited = (c) => c?.created_at === c?.updated_at
const steps = (run, jobName) => (run?.jobs ?? []).filter((j) => !jobName || j.name === jobName).flatMap((j) => j.steps ?? [])
const step = (run, prefix, jobName) => steps(run, jobName).find((s) => s.name.startsWith(prefix))
const ran = (s) => s && s.conclusion !== 'skipped' && s.started_at

export const VERIFY_STEP = 'Verify the packaged Worker'
// Present only in #505+ runs: proves the run built the reviewed flags file of this SHA (older runs took flags from inputs).
export const FLAGS_STEP = 'Load the reviewed Production flags'
export const GO_STEP = 'Require GO-PROD evidence'
export const DEPLOY_STEP = 'Publish with the Admin secrets'
export const STAGING_STEP = 'Publish only named staging'
export const COMBINED_STAGING_JOB = 'publish-m3' // the legacy M2 `publish` job writes a Public-only artifact under the same SHA tag

// TEST chain (Worker ancestors + Worker, or the whole plan) must be applied in TEST before the Owner's UAT PASS.
function planTestChainLate(plan, uatAt) {
  const p = plan.loaded.plan
  const worker = p.steps.find((s) => s.type === 'worker')
  const chain = worker ? [...ancestors(p, worker.id), worker.id] : p.steps.map((s) => s.id)
  return chain.some((id) => { const st = plan.testStates?.get(id); return st?.state !== 'applied' || !(st.at < uatAt) })
}

export function trustedRun(run, { path, repo = DEFAULT_REPOSITORY, sha }) {
  return run?.path === path && run.head_branch === 'main' && run.head_repository?.full_name === repo
    && ['workflow_dispatch', 'workflow_run'].includes(run.event) && (!sha || run.head_sha === sha)
}
// A verify OPERATION: neither the GO step nor the deploy step ran (publish runs, even failed ones, run the GO step first).
export const isVerifyOperation = (run) => !ran(step(run, GO_STEP)) && !ran(step(run, DEPLOY_STEP))

/** What fixed Staging served at time T, from the publish steps of every trusted Staging run (both M3 and legacy M2 jobs). */
export function stagingAt(stagingRuns, T, repo = DEFAULT_REPOSITORY) {
  const events = (stagingRuns ?? []).filter((run) => trustedRun(run, { path: STAGING_WORKFLOW, repo }))
    .flatMap((run) => (run.jobs ?? []).filter((j) => ['publish-m3', 'publish'].includes(j.name))
      .flatMap((j) => (j.steps ?? []).filter((s) => s.name.startsWith(STAGING_STEP) && ran(s))
        .map((s) => ({ sha: run.head_sha, job: j.name, started: s.started_at, completed: s.completed_at, conclusion: s.conclusion }))))
    .filter((e) => e.started < T)
    .sort((a, b) => (a.started < b.started ? -1 : 1))
  return events.at(-1) ?? null
}

/** Pure evaluation; returns every failed check so one run shows the full picture. */
export function evaluateGo(input) {
  const { url, comment, issue, issueComments = [], m4Runs = [], stagingRuns = [], qualityRuns = [], candidateSha, lane,
    fullTouch = null, flagsChange = '', currentRunId = null, repo = DEFAULT_REPOSITORY, plan = null, purpose = 'publish' } = input
  const fullCategoryList = Object.keys(fullTouch ?? {})
  // Plan mode: full-scope publish, or any Production plan step (SQL/function) whatever the Worker scope.
  const planMode = fullCategoryList.length > 0 || purpose !== 'publish'
  const reasons = []
  const fail = (code) => { reasons.push(code); return { ok: false, reasons } }
  if (!SHA.test(candidateSha ?? '')) return fail('CANDIDATE_SHA_INVALID')
  let ref
  try { ref = parseCommentUrl(url, repo) } catch (error) { return fail(error.message) }
  if (!comment || comment.id !== ref.commentId || comment.html_url !== url) return fail('GO_COMMENT_NOT_FOUND')
  if (!String(comment.issue_url ?? '').endsWith(`/repos/${repo}/issues/${ref.issue}`)) return fail('GO_COMMENT_WRONG_ISSUE')
  if (!issue || issue.number !== ref.issue || issue.pull_request) reasons.push('GO_NOT_ON_RELEASE_ISSUE')
  else if (issue.state !== 'open') reasons.push('GO_ISSUE_CLOSED')
  if (!isOwnerComment(comment)) reasons.push('GO_NOT_OWNER_COMMENT')
  if (!unedited(comment)) reasons.push('GO_COMMENT_EDITED')

  const own = parseDirectives(comment.body)
  const only = (type) => {
    const list = own.filter((d) => d.type === type)
    if (list.length > 1) reasons.push(`${type.toUpperCase()}_LINE_AMBIGUOUS`)
    return list[0]
  }
  const gos = own.filter((d) => d.type === 'go')
  if (gos.length !== 1) reasons.push(gos.length ? 'GO_LINE_AMBIGUOUS' : 'GO_LINE_MISSING')
  else if (gos[0].value !== candidateSha) reasons.push('GO_WRONG_SHA')
  if (own.some((d) => ['nogo', 'revoke', 'uatFail'].includes(d.type) && d.value === candidateSha)) reasons.push('GO_CONTRADICTED_IN_SAME_COMMENT')

  // Owner directives over the whole issue, in order (created_at, then id). Withdrawals (NO-GO, revoke, superseding GO, UAT FAIL)
  // count even from an edited comment (fail closed); positive approvals (GO, UAT PASS, waiver) count only from unedited ones.
  const ownerAll = [...issueComments.filter((c) => c.id !== comment.id), comment].filter(isOwnerComment).sort(byTime)
  const after = ownerAll.filter((c) => byTime(c, comment) > 0)
  for (const d of after.flatMap((c) => parseDirectives(c.body))) {
    if (d.type === 'go' && d.value !== candidateSha) { reasons.push('GO_SUPERSEDED'); break }
    if (['revoke', 'nogo'].includes(d.type) && d.value === candidateSha) { reasons.push('GO_REVOKED'); break }
  }

  // Verify: bound to one trusted verify OPERATION of this SHA, finished before the GO, not invalidated by a newer failure.
  // Plan mode uses the Production plan-check (PREFLIGHT-RUN) instead: the new Worker may need the new schema, and the publish run
  // re-verifies the packaged Worker against the migrated Production database before it deploys.
  const trusted = m4Runs.filter((r) => trustedRun(r, { path: M4_WORKFLOW, repo, sha: candidateSha }) && r.id !== currentRunId)
  if (!planMode && trusted.some((r) => r.status !== 'completed')) reasons.push('VERIFY_STATE_AMBIGUOUS_RUN_IN_PROGRESS')
  const vr = only('verifyRun')
  const bound = vr && trusted.find((r) => String(r.id) === vr.value)
  if (planMode) { /* verify not required */ } else if (!vr) reasons.push('VERIFY_RUN_MISSING')
  else if (!bound || bound.status !== 'completed' || bound.conclusion !== 'success' || !isVerifyOperation(bound)
    || step(bound, VERIFY_STEP)?.conclusion !== 'success' || step(bound, FLAGS_STEP)?.conclusion !== 'success') reasons.push('VERIFY_RUN_NOT_A_TRUSTED_VERIFY_PASS')
  else {
    if (!(bound.updated_at < comment.created_at)) reasons.push('GO_BEFORE_VERIFY_PASS')
    const newerFailure = trusted.some((r) => byTime(r, bound) > 0 && r.status === 'completed'
      && (step(r, VERIFY_STEP)?.conclusion === 'failure' || (isVerifyOperation(r) && r.conclusion === 'failure')))
    if (newerFailure) reasons.push('VERIFY_INVALIDATED_BY_NEWER_FAILURE')
  }

  // Lane: computed floor (UNKNOWN = full), optionally raised by GO, never lowered; extended/full need an explicit line.
  const computed = LANES.includes(lane) ? lane : 'full'
  const declared = only('lane')?.value
  if (declared && laneRank(declared) < laneRank(computed)) reasons.push('LANE_LOWERED')
  const effective = declared ? maxLane(computed, declared) : computed
  if (laneRank(computed) >= laneRank('extended') && !declared) reasons.push('LANE_ACK_REQUIRED')

  // UAT for every runtime lane (fast included): UAT PASS on the exact SHA while fixed Staging served it, or an Owner waiver.
  let uat = 'not-required'
  if (laneRank(effective) >= laneRank('fast')) {
    uat = 'missing'
    const timeline = ownerAll.flatMap((c) => {
      const ds = parseDirectives(c.body).filter((d) => d.value === candidateSha && (d.type === 'uatFail' || (d.type === 'uatPass' && unedited(c))))
      if (new Set(ds.map((d) => d.type)).size > 1) reasons.push('UAT_AMBIGUOUS')
      return ds.map((d) => ({ type: d.type, c }))
    })
    const failAfterGo = timeline.some((e) => e.type === 'uatFail' && byTime(e.c, comment) > 0)
    const passes = timeline.filter((e) => e.type === 'uatPass' && byTime(e.c, comment) <= 0)
    const lastPass = passes.at(-1)
    const waiver = own.find((d) => d.type === 'waiver' && d.value === candidateSha)
    if (failAfterGo) reasons.push('UAT_FAILED_AFTER_GO')
    else if (waiver) uat = 'waived'
    else if (!lastPass) reasons.push(timeline.some((e) => e.type === 'uatFail') ? 'UAT_FAILED' : 'UAT_EVIDENCE_MISSING')
    else if (timeline.some((e) => e.type === 'uatFail' && byTime(e.c, lastPass.c) > 0)) reasons.push('UAT_FAILED')
    else {
      const served = stagingAt(stagingRuns, lastPass.c.created_at, repo)
      if (!served) reasons.push('UAT_PASS_WITHOUT_STAGING_DEPLOYMENT')
      else if (served.sha !== candidateSha) reasons.push('UAT_STAGING_NOT_CANDIDATE')
      else if (served.job !== COMBINED_STAGING_JOB) reasons.push('UAT_STAGING_NOT_COMBINED_ARTIFACT')
      else if (served.conclusion !== 'success' || !(served.completed < lastPass.c.created_at)) reasons.push('UAT_STAGING_NOT_PASSED')
      else if (planMode && plan?.loaded && planTestChainLate(plan, lastPass.c.created_at)) reasons.push('UAT_BEFORE_TEST_CHAIN_APPLIED')
      else uat = 'pass'
    }
  }

  // Full scope / plan steps: a valid reviewed plan for this candidate, covering the scope, with every dependency evidenced.
  if (!fullTouch && effective === 'full') reasons.push('FULL_SCOPE_UNKNOWN')
  if (planMode) {
    const planLine = only('plan')
    if (!planLine) reasons.push('FULL_SCOPE_REQUIRES_PLAN')
    else if (!plan?.loaded) reasons.push(`PLAN_INVALID:${plan?.error ?? 'not loaded'}`)
    else if (plan.loaded.plan.test_only) reasons.push('PLAN_TEST_ONLY_NOT_FOR_PRODUCTION')
    else if (plan.loaded.plan.id !== planLine.args[0] || plan.loaded.digest !== planLine.args[1]) reasons.push('PLAN_DIGEST_MISMATCH')
    else {
      const gaps = coverageGaps(plan.loaded, plan.categories ?? {})
      if (plan.categories === undefined) reasons.push('PLAN_SCOPE_UNKNOWN')
      for (const gap of gaps) reasons.push(`PLAN_COVERAGE_GAP:${gap}`)
      const pf = only('preflightRun')
      if (!pf) reasons.push('PREFLIGHT_RUN_MISSING')
      else { const bad = preflightOk(plan.loaded, plan.sqlRuns?.production, pf.value, comment.created_at, { candidateSha, repo }); if (bad) reasons.push(bad) }
      const target = purpose === 'publish' ? 'publish' : purpose.step
      for (const gap of dependencyGaps(plan.loaded, 'production', target, { testStates: plan.testStates, prodStates: plan.prodStates })) reasons.push(gap)
      const step = purpose === 'publish' ? null : plan.loaded.plan.steps.find((s) => s.id === purpose.step)
      const opTypes = { apply: ['sql', 'backfill'], rollback: ['sql', 'backfill'], function: ['function'] }
      if (purpose !== 'publish' && (!step || !opTypes[purpose.op]?.includes(step.type))) reasons.push(`PLAN_OP_DOES_NOT_MATCH_STEP:${purpose.op}/${step?.type ?? 'unknown'}`)
      // The gated step: the named step, or the Worker for a publish. A Worker with `bindings: true` (wrangler/infra change) needs its own
      // separate STEP-GO like a destructive or privileged step; no GO line alone ships a binding change.
      const gated = step ?? plan.loaded.plan.steps.find((s) => s.type === 'worker')
      const separate = (type) => after.filter(unedited).some((c) => parseDirectives(c.body).some((d) => d.type === type
        && d.args[0] === candidateSha && d.args[1] === plan.loaded.plan.id && d.args[2] === gated?.id))
      const needsStepGo = gated && (gated.destructive || gated.privileged || gated.bindings === true) && !(purpose !== 'publish' && purpose.op === 'rollback')
      if (needsStepGo && !separate('stepGo')) reasons.push(`STEP_GO_REQUIRED:${gated.id}`)
      if (step && purpose.op === 'rollback' && !separate('rollbackGo')) reasons.push(`ROLLBACK_GO_REQUIRED:${step.id}`)
      if (step && purpose.op === 'rollback') reasons.push(...rollbackBlockers(plan.loaded, step.id, plan.prodStates))
    }
  }

  // CI: the exact candidate needs a successful trusted `quality` push run on main (no bypass through manual dispatch).
  const quality = qualityFromRuns(qualityRuns, candidateSha, repo)
  if (quality.state === 'pending') reasons.push('QUALITY_STATE_AMBIGUOUS_RUN_IN_PROGRESS')
  else if (quality.state !== 'success') reasons.push(`QUALITY_NOT_PASSED state=${quality.state}`)

  // Flags: a live flag change must be stated exactly; a stale FLAGS-CHANGE line is rejected too.
  // Only the Worker publish knows the live flag diff: SQL/function plan steps (purpose = step) must not reject a FLAGS-CHANGE line
  // that the same plan GO carries for the later Worker publish; the real live check stays at publish.
  const flagLine = only('flags')
  if (purpose === 'publish') {
    if (flagsChange && flagLine?.value !== flagsChange) reasons.push('FLAGS_CHANGE_NOT_APPROVED')
    if (!flagsChange && flagLine) reasons.push('FLAGS_CHANGE_STALE')
  }

  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], lane: effective, uat, verifyRunId: bound?.id ?? null }
}

async function withJobs(request, repo, runs) {
  return Promise.all(runs.map(async (run) => ({ ...run, jobs: (await request(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`)).jobs })))
}

export async function collectGoInputs({ url, candidateSha, request, repo = DEFAULT_REPOSITORY, root = process.cwd(), withHistory = false }) {
  const { issue: number, commentId } = parseCommentUrl(url, repo)
  const file = (path) => path.split('/').at(-1)
  const [comment, issue, issueComments, m4List, stagingForSha, qualityRuns] = await Promise.all([
    request(`/repos/${repo}/issues/comments/${commentId}`),
    request(`/repos/${repo}/issues/${number}`),
    githubList(request, `/repos/${repo}/issues/${number}/comments`),
    githubList(request, `/repos/${repo}/actions/workflows/${file(M4_WORKFLOW)}/runs?head_sha=${candidateSha}`, { key: 'workflow_runs', maxPages: 2 }),
    githubList(request, `/repos/${repo}/actions/workflows/${file(STAGING_WORKFLOW)}/runs?head_sha=${candidateSha}`, { key: 'workflow_runs', maxPages: 2 }),
    githubList(request, `/repos/${repo}/actions/workflows/${file(QUALITY_WORKFLOW)}/runs?head_sha=${candidateSha}&event=push`, { key: 'workflow_runs', maxPages: 2 }),
  ])
  // Every Staging run (any SHA) since the first one for this candidate: needed to prove what Staging served at UAT time.
  const since = stagingForSha.map((r) => r.created_at).sort()[0]
  const stagingList = since ? await githubList(request, `/repos/${repo}/actions/workflows/${file(STAGING_WORKFLOW)}/runs?created=%3E%3D${since}`, { key: 'workflow_runs', maxPages: 3 }) : []
  const m4Runs = await withJobs(request, repo, m4List)
  const stagingRuns = await withJobs(request, repo, stagingList)
  // Plan mode inputs (#511): the plan named by the GO's PLAN line, at this checkout (= candidate), and per-step lane evidence.
  let plan = null
  const planLine = parseDirectives(comment.body).find((d) => d.type === 'plan')
  if (planLine) {
    plan = {}
    try { plan.loaded = loadPlan(root, planLine.args[0]) } catch (error) { plan.error = error.message }
    const runsOf = async (path) => withJobs(request, repo, await githubList(request, `/repos/${repo}/actions/workflows/${file(path)}/runs?head_sha=${candidateSha}`, { key: 'workflow_runs', maxPages: 2 }))
    const [testLane, sqlProd, fnProd] = await Promise.all([runsOf(SQL_LANE.test), runsOf(SQL_LANE.production), runsOf(FUNCTION_LANE.production)])
    plan.sqlRuns = { production: sqlProd }
    if (plan.loaded) {
      plan.testStates = stepStates(plan.loaded, 'test', [...testLane, ...stagingRuns], { candidateSha, repo })
      plan.prodStates = stepStates(plan.loaded, 'production', [...sqlProd, ...fnProd, ...m4Runs], { candidateSha, repo })
    }
    const scope = await releaseScope(candidateSha, { withHistory })
    plan.categories = scope.unknown ? undefined : scope.categories
  }
  return { url, comment, issue, issueComments, candidateSha, repo, qualityRuns, m4Runs, stagingRuns, plan }
}

async function main() {
  const env = process.env
  const repo = env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY
  const fullTouch = env.FULL_TOUCH && env.FULL_TOUCH !== 'unknown' ? JSON.parse(env.FULL_TOUCH) : null
  const request = github()
  // Lanes whose inputs may not carry a URL (M6, function lanes) pass the numeric comment id; the URL comes from GitHub itself.
  if (!env.GO_COMMENT_URL && /^[1-9][0-9]{0,15}$/.test(env.GO_COMMENT_ID ?? '')) env.GO_COMMENT_URL = (await request(`/repos/${repo}/issues/comments/${env.GO_COMMENT_ID}`)).html_url
  const inputs = await collectGoInputs({ url: env.GO_COMMENT_URL, candidateSha: env.CANDIDATE_SHA, request, repo, withHistory: env.SCOPE_WITH_HISTORY === 'true' })
  // GO_PURPOSE=step (M6 plan-apply/rollback, Production function lane) names PLAN_STEP_ID and PLAN_OP; default = the Worker publish.
  const purpose = env.GO_PURPOSE === 'step' ? { step: env.PLAN_STEP_ID, op: env.PLAN_OP } : 'publish'
  // The dispatch must name the plan of the GO (also for the Worker publish: its run is the plan's Worker evidence, bound by that tag).
  if (inputs.plan?.loaded && (inputs.plan.loaded.plan.id !== env.PLAN_ID || inputs.plan.loaded.digest !== env.PLAN_DIGEST)) inputs.plan.error = 'DISPATCH_PLAN_DIFFERS_FROM_GO_PLAN'
  if (inputs.plan?.error === 'DISPATCH_PLAN_DIFFERS_FROM_GO_PLAN') inputs.plan.loaded = undefined
  const result = evaluateGo({ ...inputs, lane: env.RISK_LANE || 'full', fullTouch, flagsChange: env.FLAGS_CHANGE ?? '', currentRunId: Number(env.GITHUB_RUN_ID) || null, purpose })
  if (env.CHECK_MAIN_HEAD === 'true') {
    // Right before publish: main must still be the approved candidate (no newer merge slipped in after the GO).
    const head = await currentMainHead(request, repo).catch(() => 'UNKNOWN')
    if (head !== inputs.candidateSha) { result.ok = false; result.reasons.push(`SUPERSEDED main=${head}`) }
  }
  console.error(`GO_EVIDENCE status=${result.ok ? 'PASS' : 'FAIL'} lane=${result.lane ?? '-'} uat=${result.uat ?? '-'} verify_run=${result.verifyRunId ?? '-'}${result.ok ? '' : ` reasons=${result.reasons.join(',')}`}`)
  appendSummary(`- GO-PROD evidence (${env.GO_PHASE || 'check'}): **${result.ok ? 'PASS' : 'FAIL'}** — ${env.GO_COMMENT_URL || 'no GO comment'}; lane ${result.lane ?? '-'}, UAT ${result.uat ?? '-'}, verify run ${result.verifyRunId ?? '-'}${result.ok ? '' : `; ${result.reasons.join(', ')}`}. _Blocks missing/wrong/stale approval; does not authenticate the Owner (shared login)._`)
  if (!result.ok) process.exit(1)
}

if (isMain(import.meta.url)) main().catch((error) => { console.error(`GO_EVIDENCE status=FAIL reason=${error.message}`); process.exit(1) })
