// #505 D1 trigger gate, run by an unprivileged job (no environment, no secrets) before any privileged job.
// Manual dispatch keeps today's identity rules. Auto-preflight (workflow_run) is accepted only for a SUCCESSFUL `quality` run of a
// trusted push to protected main whose head is still main HEAD, and never yields `publish`: auto publish is impossible by design.
import { execFileSync } from 'node:child_process'
import { DEFAULT_REPOSITORY, OWNER, QUALITY_WORKFLOW, SHA, appendSummary, currentMainHead, github, isMain, writeOutputs } from './lib.mjs'
import { classifyLane, changedPaths } from './risk-lane.mjs'
import { lockStatus, validateUatIssue } from './staging-lock.mjs'

const OPERATIONS = { m4: ['verify', 'publish'], staging: ['prepare-m3', 'publish-m3'] }
const LEGACY_STAGING = ['verify-read-access', 'capture-snapshot', 'prepare-preview', 'publish']

/**
 * Pure decision. Returns { run, fail, sha, mode, operation, uatIssue, reason }.
 * `fail` = refuse loudly (manual misuse); `run:false` without fail = skip quietly with a reason (auto path, legacy jobs).
 */
export function evaluateTrigger({ target, event, repo, ref, actor, githubSha, input = {}, workflowRun = {}, mainHead, pushLane, lock }) {
  const skip = (reason) => ({ run: false, fail: false, reason })
  const refuse = (reason) => ({ run: false, fail: true, reason })
  if (!OPERATIONS[target]) return refuse('TARGET_INVALID')
  if (repo !== DEFAULT_REPOSITORY) return refuse('REPOSITORY_NOT_ALLOWED')
  if (ref !== 'refs/heads/main') return refuse('REF_NOT_MAIN')
  if (!SHA.test(githubSha ?? '')) return refuse('GITHUB_SHA_INVALID')

  if (event === 'workflow_dispatch') {
    if (actor !== OWNER) return refuse('ACTOR_NOT_ALLOWED')
    if (target === 'staging' && LEGACY_STAGING.includes(input.operation)) return skip('LEGACY_M2_OPERATION')
    if (!OPERATIONS[target].includes(input.operation)) return refuse('OPERATION_INVALID')
    if (input.sha !== githubSha) return refuse('APPROVED_SHA_NOT_DISPATCHED_MAIN')
    if (mainHead !== githubSha) return refuse(`SUPERSEDED main=${mainHead ?? 'UNKNOWN'}`)
    if (target === 'staging' && input.operation === 'publish-m3' && !lock?.allowed) return refuse(lock?.reason ?? 'LOCK_STATE_UNKNOWN')
    return { run: true, fail: false, sha: githubSha, mode: 'manual', operation: input.operation, uatIssue: input.uatIssue ?? '', reason: 'MANUAL_DISPATCH' }
  }

  if (event === 'workflow_run') {
    const w = workflowRun
    if (w.path !== QUALITY_WORKFLOW) return skip('UNTRUSTED_TRIGGER workflow')
    if (w.event !== 'push') return skip('UNTRUSTED_TRIGGER event')
    if (w.headBranch !== 'main' || w.headRepo !== repo) return skip('UNTRUSTED_TRIGGER ref')
    if (w.conclusion !== 'success') return skip(`QUALITY_NOT_SUCCESS ${w.conclusion}`)
    if (w.actor !== OWNER || actor !== OWNER) return skip('UNTRUSTED_TRIGGER actor')
    if (!SHA.test(w.headSha ?? '') || w.headSha !== githubSha || mainHead !== githubSha) return skip(`SUPERSEDED main=${mainHead ?? 'UNKNOWN'}`)
    if (pushLane === 'none') return skip('NO_RUNTIME_CHANGE')
    if (pushLane === 'full' || !pushLane) return skip('FULL_LANE_SEPARATE_GATES')
    if (target === 'staging' && !lock?.allowed) return skip(lock?.reason ?? 'LOCK_STATE_UNKNOWN')
    return { run: true, fail: false, sha: githubSha, mode: 'auto', operation: target === 'm4' ? 'verify' : 'publish-m3', uatIssue: '', reason: `AUTO_PREFLIGHT lane=${pushLane}` }
  }
  return refuse('EVENT_NOT_ALLOWED')
}

async function main() {
  const [target] = process.argv.slice(2)
  const env = process.env
  const request = github()
  const repo = env.GITHUB_REPOSITORY
  const event = env.GITHUB_EVENT_NAME
  const mainHead = await currentMainHead(request, repo).catch(() => 'UNKNOWN')
  let pushLane
  if (event === 'workflow_run' && SHA.test(env.WR_HEAD_SHA ?? '')) {
    // The pushed change set: head against its first parent (merge commit = the merged PR).
    // Shallow checkouts may lack the parent: fetch exactly head + parents once. Any remaining failure = unknown = full (skip).
    const parentOf = () => execFileSync('git', ['rev-parse', '--verify', '--quiet', `${env.WR_HEAD_SHA}^1`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    try {
      let parent
      try { parent = parentOf() } catch {
        execFileSync('git', ['fetch', '--quiet', '--no-tags', '--depth=2', 'origin', env.WR_HEAD_SHA], { stdio: 'ignore' })
        parent = parentOf()
      }
      pushLane = classifyLane(changedPaths(parent, env.WR_HEAD_SHA)).lane
    } catch { pushLane = 'full' }
  }
  let uatIssue = env.INPUT_UAT_ISSUE ?? ''
  let lock
  if (target === 'staging') {
    try { uatIssue = (await validateUatIssue(request, uatIssue, repo)) ?? '' } catch (error) {
      writeOutputs({ run: 'false', reason: error.message }); console.error(`TRIGGER_GATE status=FAIL reason=${error.message}`); process.exit(1)
    }
    lock = await lockStatus(request, { requestIssue: uatIssue === '' ? null : uatIssue, repo })
  }
  const decision = evaluateTrigger({
    target, event, repo, ref: env.GITHUB_REF, actor: env.GITHUB_ACTOR, githubSha: env.GITHUB_SHA, mainHead, pushLane, lock,
    input: { sha: env.INPUT_SHA, operation: env.INPUT_OPERATION, uatIssue: String(uatIssue) },
    workflowRun: { path: env.WR_PATH, event: env.WR_EVENT, headBranch: env.WR_HEAD_BRANCH, headRepo: env.WR_HEAD_REPO,
      conclusion: env.WR_CONCLUSION, actor: env.WR_ACTOR, headSha: env.WR_HEAD_SHA },
  })
  writeOutputs({ run: String(decision.run), sha: decision.sha ?? '', mode: decision.mode ?? '', operation: decision.operation ?? '',
    uat_issue: decision.uatIssue ?? '', reason: decision.reason })
  appendSummary(`### ${target === 'm4' ? 'M4 Production lane' : 'Fixed Staging'} trigger gate\n- Event \`${event}\`, decision **${decision.run ? 'RUN' : decision.fail ? 'REFUSED' : 'SKIPPED'}** — ${decision.reason}${decision.sha ? `\n- Candidate \`${decision.sha}\`, mode ${decision.mode}, operation ${decision.operation}` : ''}${lock ? `\n- UAT lock: ${lock.reason}` : ''}`)
  console.error(`TRIGGER_GATE target=${target} run=${decision.run} fail=${decision.fail} reason=${decision.reason}`)
  if (decision.fail) process.exit(1)
}

if (isMain(import.meta.url)) main().catch((error) => { console.error(`TRIGGER_GATE status=FAIL reason=${error.message}`); process.exit(1) })
