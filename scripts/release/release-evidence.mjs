// #505 evidence summary for the M4 run page: everything a readiness report used to copy by hand, pinned to the exact SHA.
// Only non-secret identifiers (SHA, version ids, flag values, run links). The GO template is printed ONLY when every applicable
// gate of this run passed; otherwise the run is labelled FAIL / PARTIAL / UNKNOWN and no approval text is offered.
import { DEFAULT_REPOSITORY, QUALITY_WORKFLOW, STAGING_WORKFLOW, appendSummary, github, isMain } from './lib.mjs'

const mark = (outcome) => ({ success: 'PASS', failure: 'FAIL', cancelled: 'FAIL', skipped: 'SKIPPED' }[outcome] ?? 'UNKNOWN')

export function readiness(e) {
  const blockers = []
  if (e.OPERATION !== 'verify') blockers.push('not a verify run')
  if (e.JOB_STATUS !== 'success') blockers.push(`job ${e.JOB_STATUS || 'UNKNOWN'}`)
  if (e.PACKAGED !== 'success') blockers.push(`packaged verify ${mark(e.PACKAGED)}`)
  if (e.ACTIVE_OUTCOME !== 'success') blockers.push(`active version/flags ${mark(e.ACTIVE_OUTCOME)}`)
  if (!e.PRODUCTION_SHA || e.PRODUCTION_SHA === 'UNKNOWN') blockers.push('release scope UNKNOWN')
  if (e.MODE === 'manual' && e.MEDIA !== 'success') blockers.push(`media test object ${mark(e.MEDIA)}`)
  if (e.MODE !== 'manual' && e.MODE !== 'auto') blockers.push('mode UNKNOWN')
  const status = !blockers.length ? 'READY' : e.JOB_STATUS === 'success' ? 'PARTIAL' : 'NOT READY'
  return { status, blockers }
}

export function renderEvidence(e, links = {}) {
  const sha = e.CANDIDATE_SHA || 'UNKNOWN'
  const lane = e.RISK_LANE || 'full'
  const touch = e.FULL_TOUCH && e.FULL_TOUCH !== 'unknown' ? JSON.parse(e.FULL_TOUCH) : null
  const flags = `pricing=${e.CANONICAL_PRICING || '?'} brands=${e.CANONICAL_BRANDS || '-'} commerce=${e.COMMERCE || '?'} series=${e.SERIES_VARIANT || '?'} (digest \`${e.FLAGS_DIGEST || '?'}\`)`
  const { status, blockers } = readiness(e)
  const rows = [
    ['Readiness for GO', `**${status}**${blockers.length ? ` — ${blockers.join('; ')}` : ''}`],
    ['Candidate', `\`${sha}\` (${e.MODE || '?'} ${e.OPERATION || '?'}), run ${e.RUN_ID || '?'}`],
    ['Production now', `\`${e.PRODUCTION_SHA || 'UNKNOWN'}\`, active version \`${e.ACTIVE_VERSION || 'UNKNOWN'}\` = rollback target`],
    ['Scope / lane floor', `${e.CHANGED_FILES || 0} files, **${lane}**${touch && Object.keys(touch).length ? `; full categories ${Object.keys(touch).join(', ')}` : ''}`],
    ['Flags (release/production-flags.json)', `${flags}; vs active: ${e.ACTIVE_OUTCOME !== 'success' ? 'UNKNOWN' : e.FLAGS_CHANGE ? `CHANGE \`${e.FLAGS_CHANGE}\`` : 'unchanged'}`],
    ['Packaged Worker vs Production DB (read-only)', mark(e.PACKAGED)],
    ['Production media test object', e.MODE === 'auto' ? 'SKIPPED (auto verify is read-only; publish runs it)' : mark(e.MEDIA)],
    ['Publish', mark(e.DEPLOY)],
    ['CI `quality` for this SHA', links.quality ?? 'UNKNOWN'],
    ['Fixed Staging for this SHA', links.staging ?? 'UNKNOWN (no successful Staging run found)'],
  ]
  const lines = ['### Release evidence (#505)', '| Check | Result |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)]
  if (status === 'READY') {
    const needLane = ['extended', 'full'].includes(lane)
    const fullCats = lane === 'full' ? Object.keys(touch ?? {}).filter((c) => c !== 'bindings') : []
    lines.push('', '**Next — Owner GO comment** on the release issue (each directive on its own line at column 0, posted after this run):', '```',
      `GO-PROD ${sha}`,
      `VERIFY-RUN ${e.RUN_ID}`,
      ...(needLane ? [`LANE ${lane}`] : []),
      `UAT PASS ${sha}`,
      ...fullCats.map((c) => `FULL-EVIDENCE ${c} <URL of the successful ${c === 'sql' ? 'm6-production-sql-apply' : 'm4-production-function-deploy'} run>`),
      ...(e.FLAGS_CHANGE ? [`FLAGS-CHANGE ${e.FLAGS_CHANGE}`] : []),
      '```',
      `UAT PASS counts only if fixed Staging served exactly \`${sha}\` at that moment (lock it with \`lock-uat\`). Otherwise the Owner replaces the line with \`UAT-WAIVER ${sha} <reason>\`.`,
      `**Publish inputs**: \`approved_source_sha=${sha}\` · \`operation=publish\` · \`rollback_version_id=${e.ACTIVE_VERSION}\` · \`go_comment_url=<GO comment URL>\``)
  }
  lines.push('', `**Rollback** (explicit command only, never automatic): \`wrangler rollback ${e.ACTIVE_VERSION || '<previous version>'} --name dongphugia-v1-public-production\` — Worker only; does not undo SQL.`)
  if (e.RUN_URL) lines.push('', `Run: ${e.RUN_URL}`)
  return lines.join('\n')
}

export async function evidenceLinks(sha, request, repo = DEFAULT_REPOSITORY) {
  const latest = async (workflow) => {
    const data = await request(`/repos/${repo}/actions/workflows/${workflow.split('/').at(-1)}/runs?head_sha=${sha}&per_page=20`)
    const run = (data.workflow_runs ?? []).filter((r) => r.head_branch === 'main').sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]
    return run ? `[${run.id}](${run.html_url}) ${run.status === 'completed' ? run.conclusion : run.status}` : undefined
  }
  const [quality, staging] = await Promise.all([latest(QUALITY_WORKFLOW).catch(() => undefined), latest(STAGING_WORKFLOW).catch(() => undefined)])
  return { quality, staging }
}

if (isMain(import.meta.url)) {
  const env = process.env
  const links = /^[0-9a-f]{40}$/.test(env.CANDIDATE_SHA ?? '') ? await evidenceLinks(env.CANDIDATE_SHA, github(), env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY).catch(() => ({})) : {}
  appendSummary(renderEvidence(env, links))
}
