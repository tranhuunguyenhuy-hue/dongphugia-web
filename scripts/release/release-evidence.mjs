// #505 evidence summary for the M4 run page: everything a readiness report used to copy by hand, pinned to the exact SHA.
// Contains only non-secret identifiers (SHA, version ids, flag values, run links). The agent's report becomes a link plus a few lines.
import { appendSummary, isMain } from './lib.mjs'

const mark = (outcome) => ({ success: 'PASS', failure: 'FAIL', cancelled: 'FAIL', skipped: 'SKIPPED' }[outcome] ?? 'UNKNOWN')

export function renderEvidence(e) {
  const sha = e.CANDIDATE_SHA || 'UNKNOWN'
  const flags = `pricing=${e.CANONICAL_PRICING || '?'} brands=${e.CANONICAL_BRANDS || '-'} commerce=${e.COMMERCE || '?'} series=${e.SERIES_VARIANT || '?'} (digest \`${e.FLAGS_DIGEST || '?'}\`)`
  const verifyPass = e.PACKAGED === 'success'
  const lane = e.RISK_LANE || 'full'
  const rows = [
    ['Candidate', `\`${sha}\` (${e.MODE || '?'} ${e.OPERATION || '?'})`],
    ['Production now', `\`${e.PRODUCTION_SHA || 'UNKNOWN'}\`, active version \`${e.ACTIVE_VERSION || 'UNKNOWN'}\` = rollback target`],
    ['Scope / lane floor', `${e.CHANGED_FILES || 0} files, **${lane}**`],
    ['Flags (release/production-flags.json)', `${flags}; vs active: ${e.FLAGS_CHANGE ? `CHANGE \`${e.FLAGS_CHANGE}\`` : 'unchanged'}`],
    ['Packaged Worker vs Production DB (read-only)', mark(e.PACKAGED)],
    ['Production media test object', e.MODE === 'auto' ? 'SKIPPED (auto verify is read-only; publish runs it)' : mark(e.MEDIA)],
    ['Publish', mark(e.DEPLOY)],
  ]
  const lines = ['### Release evidence (#505)', '| Check | Result |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)]
  if (e.OPERATION === 'verify' && verifyPass) {
    const needLane = ['extended', 'full'].includes(lane)
    const needUat = lane !== 'fast' && lane !== 'none'
    lines.push('', '**Next — Owner GO comment** (each directive on its own line, on the release issue, after this run):', '```',
      `GO-PROD ${sha}`,
      ...(needLane ? [`LANE ${lane}`] : []),
      ...(needUat ? [`UAT PASS ${sha}`] : []),
      ...(e.FLAGS_CHANGE ? [`FLAGS-CHANGE ${e.FLAGS_CHANGE}`] : []),
      '```',
      ...(needUat ? [`Without a fixed-Staging UAT of this exact SHA, the Owner replaces the UAT line with \`UAT-WAIVER ${sha} <reason>\`.`] : []),
      `**Publish inputs**: \`approved_source_sha=${sha}\` · \`operation=publish\` · \`rollback_version_id=${e.ACTIVE_VERSION || 'UNKNOWN'}\` · \`go_comment_url=<GO comment URL>\``)
  }
  lines.push('', `**Rollback** (explicit command only, never automatic): \`wrangler rollback ${e.ACTIVE_VERSION || '<previous version>'} --name dongphugia-v1-public-production\` — Worker only; does not undo SQL.`)
  if (e.RUN_URL) lines.push('', `Run: ${e.RUN_URL}`)
  return lines.join('\n')
}

if (isMain(import.meta.url)) appendSummary(renderEvidence(process.env))
