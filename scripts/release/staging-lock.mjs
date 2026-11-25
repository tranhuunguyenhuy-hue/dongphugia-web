// #505 fixed Staging UAT lock. Holder = the one OPEN issue labelled `staging-uat-lock`; bound SHA = the latest trusted
// `STAGING-UAT-LOCK <sha>` line on it (Owner, or this workflow's bot after a successful publish). Every Staging publish (manual and
// auto) checks it before building and again right before deploying, under the `m2-fixed-staging` concurrency group.
// Never auto-released: the agent/Owner removes the label after the Owner's UAT verdict. Ambiguous or unreadable state = locked.
import { DEFAULT_REPOSITORY, SHA, appendSummary, currentMainHead, github, githubList, isMain, isOwnerComment, plainLines, writeOutputs } from './lib.mjs'

export const LOCK_LABEL = 'staging-uat-lock'
const LOCK_LINE = /^STAGING-UAT-LOCK ([0-9a-f]{40})$/
const isWorkflowBot = (c) => c?.user?.login === 'github-actions[bot]' && c?.user?.type === 'Bot'

export function lockedSha(comments) {
  let sha = null
  for (const c of [...(comments ?? [])].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))) {
    if (!isOwnerComment(c) && !isWorkflowBot(c)) continue
    for (const line of plainLines(c.body)) {
      const m = line.match(LOCK_LINE)
      if (m) sha = m[1]
    }
  }
  return sha
}

/** holders: open issues carrying the label, each with `comments`. requestIssue: issue a manual dispatch publishes for (or null). */
export function evaluateLock({ holders, requestIssue = null }) {
  if (!Array.isArray(holders)) return { state: 'unknown', allowed: false, reason: 'LOCK_STATE_UNKNOWN' }
  if (holders.length === 0) return { state: 'free', allowed: true, reason: 'LOCK_FREE' }
  if (holders.length > 1) {
    return { state: 'unknown', allowed: false, reason: `LOCK_AMBIGUOUS holders=${holders.map((h) => `#${h.number}`).join(',')}` }
  }
  const [holder] = holders
  const sha = lockedSha(holder.comments)
  if (requestIssue !== null && Number(requestIssue) === holder.number) {
    return { state: 'held', holder: holder.number, lockedSha: sha, allowed: true, reason: 'LOCK_HELD_BY_REQUESTER' }
  }
  return { state: 'held', holder: holder.number, lockedSha: sha, allowed: false,
    reason: `STAGING_UAT_LOCKED issue=#${holder.number} sha=${sha ?? 'UNKNOWN'}` }
}

export async function readHolders(request, repo = DEFAULT_REPOSITORY) {
  const issues = await githubList(request, `/repos/${repo}/issues?state=open&labels=${LOCK_LABEL}`)
  return Promise.all(issues.map(async (issue) => ({ number: issue.number, comments: await githubList(request, `/repos/${repo}/issues/${issue.number}/comments`) })))
}

export async function lockStatus(request, { requestIssue = null, repo = DEFAULT_REPOSITORY } = {}) {
  try { return evaluateLock({ holders: await readHolders(request, repo), requestIssue }) } catch (error) {
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
  const manual = env.MODE === 'manual'
  if (command === 'recheck') {
    // Right before deploy: still the newest main (an old queued run must not overwrite a newer one) and the lock still allows it.
    const issue = await validateUatIssue(request, env.UAT_ISSUE, repo)
    const head = await currentMainHead(request, repo).catch(() => 'UNKNOWN')
    const lock = await lockStatus(request, { requestIssue: issue, repo })
    const reason = head !== sha ? `SUPERSEDED main=${head}` : lock.allowed ? null : lock.reason
    writeOutputs({ go: reason ? 'false' : 'true', reason: reason ?? lock.reason })
    appendSummary(`- Staging deploy recheck: ${reason ? `**NOT DEPLOYED** — ${reason}` : `PASS (${lock.reason})`}`)
    console.error(`STAGING_RECHECK go=${!reason} ${reason ?? lock.reason}`)
    if (reason && manual) process.exit(1)
    return
  }
  if (command === 'acquire') {
    // Called only after a successful manual publish for an issue, still inside the staging concurrency group.
    const issue = await validateUatIssue(request, env.UAT_ISSUE, repo)
    if (!issue) throw new Error('UAT_ISSUE_REQUIRED')
    await request(`/repos/${repo}/issues/${issue}/labels`, { method: 'POST', body: { labels: [LOCK_LABEL] } })
    await request(`/repos/${repo}/issues/${issue}/comments`, { method: 'POST', body: { body: [
      `STAGING-UAT-LOCK ${sha}`, '',
      `Fixed Staging now serves this exact SHA for Owner UAT (run ${env.RUN_URL ?? '-'}). Other Staging publishes are refused while the`,
      `\`${LOCK_LABEL}\` label is on this open issue. Release: remove the label after the Owner's UAT verdict (never automatic).`,
    ].join('\n') } })
    appendSummary(`- Staging UAT lock acquired: #${issue} @ \`${sha}\``)
    console.error(`STAGING_LOCK acquired issue=#${issue} sha=${sha}`)
    return
  }
  throw new Error('USAGE: staging-lock.mjs recheck|acquire')
}

if (isMain(import.meta.url)) main().catch((error) => { console.error(`STAGING_LOCK status=FAIL reason=${error.message}`); process.exit(1) })
