// #505 fixed Staging UAT lock. Holder = the one OPEN issue labelled `staging-uat-lock`; bound SHA = the newest trusted
// `STAGING-UAT-LOCK <sha>` line on it (Owner, or this workflow's bot). EVERY Staging publisher (M3 publish-m3, legacy M2 publish,
// auto and manual) checks it before building and again right before deploying, under the `m2-fixed-staging` concurrency group.
// While held, only the holder may redeploy, and only the SAME SHA (retry). A different SHA needs an explicit release (remove the
// label) and a re-acquire. A label without exactly one valid SHA is UNKNOWN and blocks everyone. Never auto-released.
import {
  DEFAULT_REPOSITORY, SHA, appendSummary, byTime, cloudflare, currentMainHead, github, githubList, isCombinedStagingIdentity, isMain,
  isOwnerComment, liveStagingSha, plainLines, writeOutputs,
} from './lib.mjs'
import { testChainForStaging } from './plan-evidence.mjs'
import { releaseScope } from './risk-lane.mjs'

export const LOCK_LABEL = 'staging-uat-lock'
const LOCK_LINE = /^STAGING-UAT-LOCK ([0-9a-f]{40})$/
const isWorkflowBot = (c) => c?.user?.login === 'github-actions[bot]' && c?.user?.type === 'Bot'

/** Newest trusted lock SHA; `ambiguous` when one comment names two different SHAs or a lock comment was edited (editing must not
 *  re-point a held lock without the release/re-acquire step). Untrusted authors, quotes and code are ignored. */
export function lockedSha(comments) {
  let sha = null
  for (const c of [...(comments ?? [])].sort(byTime)) {
    if (!isOwnerComment(c) && !isWorkflowBot(c)) continue
    const shas = new Set(plainLines(c.body).map((line) => line.match(LOCK_LINE)?.[1]).filter(Boolean))
    if (shas.size > 1 || (shas.size && c.created_at !== c.updated_at)) return { sha: null, ambiguous: true }
    if (shas.size === 1) sha = [...shas][0]
  }
  return { sha, ambiguous: false }
}

/** holders: open issues carrying the label (each with comments). requestIssue: issue a manual publish/lock is for (or null). */
export function evaluateLock({ holders, requestIssue = null, candidateSha }) {
  if (!Array.isArray(holders)) return { state: 'unknown', allowed: false, reason: 'LOCK_STATE_UNKNOWN' }
  if (holders.length === 0) return { state: 'free', allowed: true, reason: 'LOCK_FREE' }
  if (holders.length > 1) return { state: 'unknown', allowed: false, reason: `LOCK_AMBIGUOUS holders=${holders.map((h) => `#${h.number}`).join(',')}` }
  const [holder] = holders
  const { sha, ambiguous } = lockedSha(holder.comments)
  if (ambiguous || !sha) {
    return { state: 'unknown', holder: holder.number, allowed: false,
      reason: `LOCK_SHA_UNKNOWN issue=#${holder.number} (post one STAGING-UAT-LOCK <sha> line or remove the label)` }
  }
  const mine = requestIssue !== null && Number(requestIssue) === holder.number
  if (mine && candidateSha === sha) return { state: 'held', holder: holder.number, lockedSha: sha, allowed: true, reason: 'LOCK_HELD_BY_REQUESTER_SAME_SHA' }
  if (mine) {
    return { state: 'held', holder: holder.number, lockedSha: sha, allowed: false,
      reason: `STAGING_UAT_LOCKED_DIFFERENT_SHA issue=#${holder.number} locked=${sha} candidate=${candidateSha} (release the label, then re-acquire)` }
  }
  return { state: 'held', holder: holder.number, lockedSha: sha, allowed: false, reason: `STAGING_UAT_LOCKED issue=#${holder.number} sha=${sha}` }
}

export async function readHolders(request, repo = DEFAULT_REPOSITORY) {
  const issues = await githubList(request, `/repos/${repo}/issues?state=open&labels=${LOCK_LABEL}`)
  return Promise.all(issues.map(async (issue) => ({ number: issue.number, comments: await githubList(request, `/repos/${repo}/issues/${issue.number}/comments`) })))
}

export async function lockStatus(request, { requestIssue = null, candidateSha, repo = DEFAULT_REPOSITORY } = {}) {
  try { return evaluateLock({ holders: await readHolders(request, repo), requestIssue, candidateSha }) } catch (error) {
    return { state: 'unknown', allowed: false, reason: `LOCK_STATE_UNKNOWN ${error.message}` }
  }
}

export async function validateUatIssue(request, issueNumber, repo = DEFAULT_REPOSITORY) {
  if (issueNumber === '' || issueNumber === null || issueNumber === undefined) return null
  if (!/^[1-9][0-9]*$/.test(String(issueNumber))) throw new Error('UAT_ISSUE_INVALID')
  const issue = await request(`/repos/${repo}/issues/${issueNumber}`)
  if (issue.pull_request || issue.state !== 'open') throw new Error('UAT_ISSUE_NOT_OPEN_ISSUE')
  return Number(issueNumber)
}

async function main() {
  const [command] = process.argv.slice(2)
  const env = process.env
  const repo = env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY
  const request = github()
  const sha = env.CANDIDATE_SHA
  if (!SHA.test(sha ?? '')) throw new Error('CANDIDATE_SHA_INVALID')
  const issue = await validateUatIssue(request, env.UAT_ISSUE, repo)
  const head = await currentMainHead(request, repo).catch(() => 'UNKNOWN')
  const lock = await lockStatus(request, { requestIssue: issue, candidateSha: sha, repo })
  // The legacy M2 publisher is disabled (Public-only artifact under the same SHA tag would overwrite the combined Staging).
  // A TEST DB/function writer (not a Staging Worker publish) is refused under ANY held lock, the holder included (#511).
  const testWriteUnderLock = env.TEST_WRITER === 'true' && lock.state === 'held' ? `TEST_WRITE_REFUSED_UAT_LOCK_HELD issue=#${lock.holder} (release the label after the verdict, then write)` : null
  let blocked = env.LEGACY_M2 === 'true' ? 'LEGACY_M2_PUBLISH_DISABLED' : head !== sha ? `SUPERSEDED main=${head}` : testWriteUnderLock ?? (lock.allowed ? null : lock.reason)
  if (!blocked && (command === 'acquire' || env.STAGING_WRITER === 'worker')) {
    // #511: a full-scope candidate reaches the combined Staging only with its plan and the TEST chain before the Worker applied;
    // lock-uat additionally needs the TEST Worker step itself (no UAT before every TEST dependency passed). Unknown scope = refuse.
    const scope = await releaseScope(sha)
    const gaps = scope.unknown ? ['RELEASE_SCOPE_UNKNOWN'] : await testChainForStaging({ request, repo, sha, planId: env.PLAN_ID, planDigest: env.PLAN_DIGEST,
      includeWorker: command === 'acquire', categories: scope.categories }).catch((error) => [`PLAN_EVIDENCE_UNKNOWN:${error.message}`])
    if (!gaps.length && command === 'recheck' && issue && Object.keys(scope.categories ?? {}).length) {
      // The lock line needs the COMPLETED publish-m3 of this plan as evidence, which a same-run lock step can never have: refuse before any write.
      gaps.push('FULL_SCOPE_PUBLISH_AND_LOCK_NOT_COMBINED (run publish-m3 without uat_issue, then lock-uat with uat_issue)')
    }
    if (gaps.length) blocked = gaps.join(',')
  }
  if (command === 'recheck') {
    // Right before deploy: still the newest main (an older queued run never overwrites a newer one) and the lock still allows it.
    writeOutputs({ go: blocked ? 'false' : 'true', reason: blocked ?? lock.reason })
    appendSummary(`- Staging deploy recheck: ${blocked ? `**NOT DEPLOYED** — ${blocked}` : `PASS (${lock.reason})`}${issue ? '' : '\n- UAT lock: **none taken by this run** — Staging is NOT protected for UAT until `lock-uat` (or publish-m3 with uat_issue) records a lock.'}`)
    console.error(`STAGING_RECHECK go=${!blocked} ${blocked ?? lock.reason}`)
    if (blocked && env.MODE === 'manual') process.exit(1)
    return
  }
  if (command === 'acquire') {
    // After a successful manual publish, or the `lock-uat` operation: pin the SHA Staging ACTUALLY serves (live identity), no redeploy.
    if (!issue) throw new Error('UAT_ISSUE_REQUIRED')
    if (blocked) throw new Error(blocked)
    const live = await liveStagingSha(cloudflare())
    if (!isCombinedStagingIdentity(live, sha)) throw new Error(`STAGING_LIVE_NOT_COMBINED_CANDIDATE live=${live.sha} message=${JSON.stringify(live.message)}`)
    if (lock.state === 'held') {
      appendSummary(`- Staging UAT lock already held by #${issue} @ \`${sha}\` (live deployment ${live.deploymentId})`)
      console.error(`STAGING_LOCK already-held issue=#${issue} sha=${sha}`)
      return
    }
    // Lock line first, label second: a partial failure leaves no label (= no lock) rather than a label bound to an old line.
    await request(`/repos/${repo}/issues/${issue}/comments`, { method: 'POST', body: { body: [
      `STAGING-UAT-LOCK ${sha}`, '',
      `The newest fixed-Staging deployment ${live.deploymentId} carries tag \`${sha}\` and message \`${live.message}\` (combined M3 publisher); run ${env.RUN_URL ?? '-'}. Content hashes are not compared.`,
      `Other Staging publishes, and other SHAs for this issue, are refused while the \`${LOCK_LABEL}\` label is on this open issue.`,
      'Release: remove the label after the Owner\'s UAT verdict (never automatic).',
    ].join('\n') } })
    await request(`/repos/${repo}/issues/${issue}/labels`, { method: 'POST', body: { labels: [LOCK_LABEL] } })
    appendSummary(`- Staging UAT lock acquired: #${issue} @ \`${sha}\` (newest deployment ${live.deploymentId}, message \`${live.message}\`)`)
    console.error(`STAGING_LOCK acquired issue=#${issue} sha=${sha}`)
    return
  }
  throw new Error('USAGE: staging-lock.mjs recheck|acquire')
}

if (isMain(import.meta.url)) main().catch((error) => { console.error(`STAGING_LOCK status=FAIL reason=${error.message}`); process.exit(1) })
