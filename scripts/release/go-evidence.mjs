// #505 D3-A: a Production publish requires a real GO-PROD comment for the exact candidate, posted after a trusted verify PASS.
// LIMIT: agents, Tech Lead and Owner share one GitHub login, so this blocks a MISSING, WRONG, STALE or REVOKED approval; it does NOT
// authenticate the Owner and is not an independent security boundary (option D3-B, separate identity, is deferred).
//
// Directive syntax: each directive is a whole line on its own, outside code blocks and quotes, in a comment by the repository OWNER.
//   GO-PROD <40-hex sha>                 required, exactly one, in the GO comment
//   LANE <fast|standard|extended|full>   required when the computed lane floor is extended/full; may raise, never lower
//   UAT PASS <sha> | UAT-WAIVER <sha> <reason>   required for standard and above (UAT PASS may also be an earlier comment)
//   FLAGS-CHANGE <key=value;...>          required exactly when the reviewed flags differ from the active version
//   NO-GO <sha> | GO-PROD-REVOKE <sha> | UAT FAIL <sha>   withdraw approval
import { DEFAULT_REPOSITORY, M4_WORKFLOW, SHA, STAGING_WORKFLOW, appendSummary, currentMainHead, github, githubList, isMain, isOwnerComment, plainLines } from './lib.mjs'
import { LANES, laneRank, maxLane } from './risk-lane.mjs'

const DIRECTIVE = [
  ['go', /^GO-PROD ([0-9a-f]{40})$/],
  ['revoke', /^GO-PROD-REVOKE ([0-9a-f]{40})$/],
  ['nogo', /^NO-GO ([0-9a-f]{40})$/],
  ['uatPass', /^UAT PASS ([0-9a-f]{40})$/],
  ['uatFail', /^UAT FAIL ([0-9a-f]{40})$/],
  ['waiver', /^UAT-WAIVER ([0-9a-f]{40}) (\S.{2,})$/],
  ['lane', new RegExp(`^LANE (${LANES.filter((l) => l !== 'none').join('|')})$`)],
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
const finished = (run) => run.updated_at

export function trustedRun(run, { sha, path, repo = DEFAULT_REPOSITORY }) {
  return run?.path === path && run.head_sha === sha && run.head_branch === 'main' && run.head_repository?.full_name === repo
    && ['workflow_dispatch', 'workflow_run'].includes(run.event) && run.status === 'completed' && run.conclusion === 'success'
}

const stepPassed = (jobs, jobName, stepPrefix) => (jobs ?? []).some((job) => (!jobName || job.name === jobName)
  && job.conclusion === 'success' && (job.steps ?? []).some((s) => s.name.startsWith(stepPrefix) && s.conclusion === 'success'))

export const VERIFY_STEP = 'Verify the packaged Worker'
export const STAGING_JOB = 'publish-m3'
export const STAGING_STEP = 'Publish only named staging'

/**
 * Pure evaluation. `verifyRuns`/`stagingRuns` are workflow runs for the candidate, each with its `jobs` (steps included).
 * Returns every failed check so an operator sees the full picture in one run.
 */
export function evaluateGo({ url, comment, issue, issueComments, verifyRuns, stagingRuns, candidateSha, lane, flagsChange = '', repo = DEFAULT_REPOSITORY }) {
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
  const gos = own.filter((d) => d.type === 'go')
  if (gos.length !== 1) reasons.push(gos.length ? 'GO_LINE_AMBIGUOUS' : 'GO_LINE_MISSING')
  else if (gos[0].value !== candidateSha) reasons.push('GO_WRONG_SHA')
  if (own.some((d) => ['nogo', 'revoke'].includes(d.type))) reasons.push('GO_CONTRADICTED_IN_SAME_COMMENT')

  // Approval must follow a trusted verify PASS of the same candidate (flags are code at that SHA, so same candidate = same flags).
  const verified = (verifyRuns ?? []).filter((run) => trustedRun(run, { sha: candidateSha, path: M4_WORKFLOW, repo })
    && stepPassed(run.jobs, null, VERIFY_STEP))
  if (!verified.length) reasons.push('VERIFY_PASS_MISSING')
  else if (!verified.some((run) => finished(run) < comment.created_at)) reasons.push('GO_BEFORE_VERIFY_PASS')

  // Later Owner directives in the same issue can supersede or withdraw the approval.
  const later = (issueComments ?? []).filter((c) => isOwnerComment(c) && c.created_at > comment.created_at && c.id !== comment.id)
  for (const d of later.flatMap((c) => parseDirectives(c.body))) {
    if (d.type === 'go' && d.value !== candidateSha) { reasons.push('GO_SUPERSEDED'); break }
    if (['revoke', 'nogo'].includes(d.type) && d.value === candidateSha) { reasons.push('GO_REVOKED'); break }
  }

  // Lane: computed floor, optionally raised by GO; never lowered. extended/full need an explicit acknowledgement line.
  const computed = LANES.includes(lane) ? lane : 'full'
  const laneLines = own.filter((d) => d.type === 'lane')
  if (laneLines.length > 1) reasons.push('LANE_LINE_AMBIGUOUS')
  const declared = laneLines[0]?.value
  if (declared && laneRank(declared) < laneRank(computed)) reasons.push('LANE_LOWERED')
  const effective = declared ? maxLane(computed, declared) : computed
  if (laneRank(computed) >= laneRank('extended') && !declared) reasons.push('LANE_ACK_REQUIRED')

  // UAT on the exact candidate for standard and above, or an explicit Owner waiver with a reason in the GO comment.
  const uatRequired = laneRank(effective) >= laneRank('standard')
  let uat = uatRequired ? 'missing' : 'not-required'
  if (uatRequired) {
    const waiver = own.find((d) => d.type === 'waiver' && d.value === candidateSha)
    const history = (issueComments ?? []).filter((c) => isOwnerComment(c) && unedited(c) && c.created_at <= comment.created_at)
    const timeline = [...history.filter((c) => c.id !== comment.id), comment]
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
      .flatMap((c) => parseDirectives(c.body).filter((d) => ['uatPass', 'uatFail'].includes(d.type) && d.value === candidateSha))
    const lastUat = timeline.at(-1)?.type
    const staged = (stagingRuns ?? []).some((run) => trustedRun(run, { sha: candidateSha, path: STAGING_WORKFLOW, repo })
      && stepPassed(run.jobs, STAGING_JOB, STAGING_STEP))
    if (waiver) uat = 'waived'
    else if (lastUat === 'uatPass' && staged) uat = 'pass'
    else if (lastUat === 'uatPass') reasons.push('UAT_PASS_WITHOUT_STAGING_DEPLOYMENT')
    else if (lastUat === 'uatFail') reasons.push('UAT_FAILED')
    else reasons.push('UAT_EVIDENCE_MISSING')
  }

  // Flags: a live flag change must be stated exactly; a stale FLAGS-CHANGE line is rejected too.
  const flagLines = own.filter((d) => d.type === 'flags')
  if (flagLines.length > 1) reasons.push('FLAGS_LINE_AMBIGUOUS')
  if (flagsChange && flagLines[0]?.value !== flagsChange) reasons.push('FLAGS_CHANGE_NOT_APPROVED')
  if (!flagsChange && flagLines.length) reasons.push('FLAGS_CHANGE_STALE')

  return { ok: reasons.length === 0, reasons, lane: effective, uat, verifyRunIds: verified.map((r) => r.id) }
}

async function withJobs(request, runs) {
  return Promise.all(runs.map(async (run) => ({ ...run, jobs: (await request(`/repos/${run.repository?.full_name ?? DEFAULT_REPOSITORY}/actions/runs/${run.id}/jobs?per_page=100`)).jobs })))
}

export async function collectGoInputs({ url, candidateSha, request, repo = DEFAULT_REPOSITORY }) {
  const { issue: number, commentId } = parseCommentUrl(url, repo)
  const [comment, issue, issueComments, verifyList, stagingList] = await Promise.all([
    request(`/repos/${repo}/issues/comments/${commentId}`),
    request(`/repos/${repo}/issues/${number}`),
    githubList(request, `/repos/${repo}/issues/${number}/comments`),
    request(`/repos/${repo}/actions/workflows/${M4_WORKFLOW.split('/').at(-1)}/runs?head_sha=${candidateSha}&status=success&per_page=50`),
    request(`/repos/${repo}/actions/workflows/${STAGING_WORKFLOW.split('/').at(-1)}/runs?head_sha=${candidateSha}&status=success&per_page=50`),
  ])
  return {
    url, comment, issue, issueComments, candidateSha, repo,
    verifyRuns: await withJobs(request, verifyList.workflow_runs ?? []),
    stagingRuns: await withJobs(request, stagingList.workflow_runs ?? []),
  }
}

async function main() {
  const env = process.env
  const inputs = await collectGoInputs({ url: env.GO_COMMENT_URL, candidateSha: env.CANDIDATE_SHA, request: github(), repo: env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY })
  const result = evaluateGo({ ...inputs, lane: env.RISK_LANE, flagsChange: env.FLAGS_CHANGE ?? '' })
  if (env.CHECK_MAIN_HEAD === 'true') {
    // Right before publish: main must still be the approved candidate (no newer merge slipped in after the GO).
    const head = await currentMainHead(github(), inputs.repo).catch(() => 'UNKNOWN')
    if (head !== inputs.candidateSha) { result.ok = false; result.reasons.push(`SUPERSEDED main=${head}`) }
  }
  const line = `GO_EVIDENCE status=${result.ok ? 'PASS' : 'FAIL'} lane=${result.lane ?? '-'} uat=${result.uat ?? '-'} verify_runs=${(result.verifyRunIds ?? []).join(',') || '-'}${result.ok ? '' : ` reasons=${result.reasons.join(',')}`}`
  console.error(line)
  appendSummary(`- GO-PROD evidence (${env.GO_PHASE || 'check'}): **${result.ok ? 'PASS' : 'FAIL'}** — ${env.GO_COMMENT_URL || 'no GO comment'}; lane ${result.lane ?? '-'}, UAT ${result.uat ?? '-'}${result.ok ? '' : `; ${result.reasons.join(', ')}`}. _Blocks missing/wrong/stale approval; does not authenticate the Owner (shared login)._`)
  if (!result.ok) process.exit(1)
}

if (isMain(import.meta.url)) main().catch((error) => { console.error(`GO_EVIDENCE status=FAIL reason=${error.message}`); process.exit(1) })
