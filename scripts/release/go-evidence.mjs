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
//   FULL-EVIDENCE <sql|function> <run URL>   full lane: the category's own lane ran on a SHA containing the change
//   FLAGS-CHANGE <key=value;...>         required exactly when the reviewed flags differ from the active version
//   NO-GO <sha> | GO-PROD-REVOKE <sha> | UAT FAIL <sha>   withdraw approval (also after the GO, up to the pre-deploy recheck)
import {
  DEFAULT_REPOSITORY, FUNCTION_WORKFLOW, M4_WORKFLOW, SHA, SQL_WORKFLOW, STAGING_WORKFLOW, appendSummary, byTime,
  currentMainHead, github, githubList, isMain, isOwnerComment, plainLines,
} from './lib.mjs'
import { LANES, laneRank, maxLane } from './risk-lane.mjs'

const RUN_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/([1-9][0-9]*)$/
const DIRECTIVE = [
  ['go', /^GO-PROD ([0-9a-f]{40})$/],
  ['revoke', /^GO-PROD-REVOKE ([0-9a-f]{40})$/],
  ['nogo', /^NO-GO ([0-9a-f]{40})$/],
  ['uatPass', /^UAT PASS ([0-9a-f]{40})$/],
  ['uatFail', /^UAT FAIL ([0-9a-f]{40})$/],
  ['waiver', /^UAT-WAIVER ([0-9a-f]{40}) (\S.{2,})$/],
  ['verifyRun', /^VERIFY-RUN ([1-9][0-9]*)$/],
  ['lane', new RegExp(`^LANE (${LANES.filter((l) => l !== 'none').join('|')})$`)],
  ['fullEvidence', /^FULL-EVIDENCE (sql|function) (https:\/\/github\.com\/\S+)$/],
  ['flags', /^FLAGS-CHANGE ([a-z_]+=[a-z,-]+(?:;[a-z_]+=[a-z,-]+)*)$/],
]

export function parseDirectives(body) {
  const found = []
  for (const line of plainLines(body)) {
    for (const [type, re] of DIRECTIVE) {
      const m = line.match(re)
      if (m) found.push({ type, value: m[1], extra: m[2] })
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
const FULL = {
  sql: { path: SQL_WORKFLOW, step: 'Verify the fresh backup evidence' }, // runs only for mutating SQL operations
  function: { path: FUNCTION_WORKFLOW, step: 'Deploy function and set its secrets' },
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
        .map((s) => ({ sha: run.head_sha, started: s.started_at, completed: s.completed_at, conclusion: s.conclusion }))))
    .filter((e) => e.started < T)
    .sort((a, b) => (a.started < b.started ? -1 : 1))
  return events.at(-1) ?? null
}

/** Pure evaluation; returns every failed check so one run shows the full picture. */
export function evaluateGo(input) {
  const { url, comment, issue, issueComments = [], m4Runs = [], stagingRuns = [], fullRuns = {}, ancestry = {}, candidateSha, lane,
    fullTouch = null, flagsChange = '', currentRunId = null, repo = DEFAULT_REPOSITORY } = input
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

  // Owner directives over the whole issue, in order (created_at, then id). Edited comments never count.
  const owner = [...issueComments.filter((c) => c.id !== comment.id), comment].filter((c) => isOwnerComment(c) && unedited(c)).sort(byTime)
  const after = owner.filter((c) => byTime(c, comment) > 0)
  for (const d of after.flatMap((c) => parseDirectives(c.body))) {
    if (d.type === 'go' && d.value !== candidateSha) { reasons.push('GO_SUPERSEDED'); break }
    if (['revoke', 'nogo'].includes(d.type) && d.value === candidateSha) { reasons.push('GO_REVOKED'); break }
  }

  // Verify: bound to one trusted verify OPERATION of this SHA, finished before the GO, not invalidated by a newer failure.
  const trusted = m4Runs.filter((r) => trustedRun(r, { path: M4_WORKFLOW, repo, sha: candidateSha }) && r.id !== currentRunId)
  if (trusted.some((r) => r.status !== 'completed')) reasons.push('VERIFY_STATE_AMBIGUOUS_RUN_IN_PROGRESS')
  const vr = only('verifyRun')
  const bound = vr && trusted.find((r) => String(r.id) === vr.value)
  if (!vr) reasons.push('VERIFY_RUN_MISSING')
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
    const timeline = owner.flatMap((c) => {
      const ds = parseDirectives(c.body).filter((d) => ['uatPass', 'uatFail'].includes(d.type) && d.value === candidateSha)
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
      else if (served.conclusion !== 'success' || !(served.completed < lastPass.c.created_at)) reasons.push('UAT_STAGING_NOT_PASSED')
      else uat = 'pass'
    }
  }

  // Full lane: each SQL/function change needs its own existing lane to have run (mutating, successful, before the GO) on a SHA
  // that contains the newest change of that category. Binding changes ship in this artifact and need the LANE full line only.
  if (effective === 'full') {
    if (!fullTouch) reasons.push('FULL_SCOPE_UNKNOWN')
    else {
      for (const category of Object.keys(fullTouch).filter((c) => FULL[c])) {
        const line = own.find((d) => d.type === 'fullEvidence' && d.value === category)
        const m = line?.extra?.match(RUN_URL)
        const run = m && m[1] === repo ? fullRuns[m[2]] : null
        if (!line) { reasons.push(`FULL_EVIDENCE_MISSING:${category}`); continue }
        if (!run || !trustedRun(run, { path: FULL[category].path, repo }) || run.event !== 'workflow_dispatch' || run.status !== 'completed'
          || run.conclusion !== 'success' || step(run, FULL[category].step)?.conclusion !== 'success' || !(run.updated_at < comment.created_at)) {
          reasons.push(`FULL_EVIDENCE_INVALID:${category}`); continue
        }
        if (!['ahead', 'identical'].includes(ancestry[`${fullTouch[category]}...${run.head_sha}`])) reasons.push(`FULL_EVIDENCE_STALE:${category}`)
      }
    }
  }

  // Flags: a live flag change must be stated exactly; a stale FLAGS-CHANGE line is rejected too.
  const flagLine = only('flags')
  if (flagsChange && flagLine?.value !== flagsChange) reasons.push('FLAGS_CHANGE_NOT_APPROVED')
  if (!flagsChange && flagLine) reasons.push('FLAGS_CHANGE_STALE')

  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], lane: effective, uat, verifyRunId: bound?.id ?? null }
}

async function withJobs(request, repo, runs) {
  return Promise.all(runs.map(async (run) => ({ ...run, jobs: (await request(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`)).jobs })))
}

export async function collectGoInputs({ url, candidateSha, request, repo = DEFAULT_REPOSITORY, fullTouch = null }) {
  const { issue: number, commentId } = parseCommentUrl(url, repo)
  const file = (path) => path.split('/').at(-1)
  const [comment, issue, issueComments, m4List, stagingForSha] = await Promise.all([
    request(`/repos/${repo}/issues/comments/${commentId}`),
    request(`/repos/${repo}/issues/${number}`),
    githubList(request, `/repos/${repo}/issues/${number}/comments`),
    githubList(request, `/repos/${repo}/actions/workflows/${file(M4_WORKFLOW)}/runs?head_sha=${candidateSha}`, { key: 'workflow_runs', maxPages: 2 }),
    githubList(request, `/repos/${repo}/actions/workflows/${file(STAGING_WORKFLOW)}/runs?head_sha=${candidateSha}`, { key: 'workflow_runs', maxPages: 2 }),
  ])
  // Every Staging run (any SHA) since the first one for this candidate: needed to prove what Staging served at UAT time.
  const since = stagingForSha.map((r) => r.created_at).sort()[0]
  const stagingList = since ? await githubList(request, `/repos/${repo}/actions/workflows/${file(STAGING_WORKFLOW)}/runs?created=%3E%3D${since}`, { key: 'workflow_runs', maxPages: 3 }) : []
  const fullRuns = {}
  const ancestry = {}
  for (const d of parseDirectives(comment.body).filter((x) => x.type === 'fullEvidence')) {
    const m = d.extra.match(RUN_URL)
    if (!m || m[1] !== repo) continue
    const run = (await withJobs(request, repo, [await request(`/repos/${repo}/actions/runs/${m[2]}`)]))[0]
    fullRuns[m[2]] = run
    const touch = fullTouch?.[d.value]
    if (touch && SHA.test(run.head_sha ?? '')) ancestry[`${touch}...${run.head_sha}`] = (await request(`/repos/${repo}/compare/${touch}...${run.head_sha}`)).status
  }
  return { url, comment, issue, issueComments, candidateSha, repo, fullRuns, ancestry,
    m4Runs: await withJobs(request, repo, m4List), stagingRuns: await withJobs(request, repo, stagingList) }
}

async function main() {
  const env = process.env
  const repo = env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY
  const fullTouch = env.FULL_TOUCH && env.FULL_TOUCH !== 'unknown' ? JSON.parse(env.FULL_TOUCH) : null
  const request = github()
  const inputs = await collectGoInputs({ url: env.GO_COMMENT_URL, candidateSha: env.CANDIDATE_SHA, request, repo, fullTouch })
  const result = evaluateGo({ ...inputs, lane: env.RISK_LANE, fullTouch, flagsChange: env.FLAGS_CHANGE ?? '', currentRunId: Number(env.GITHUB_RUN_ID) || null })
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
