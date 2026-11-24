// #470 m6 — pure, unit-tested checks for the Production SQL lane. Every function FAILS CLOSED by throwing an Error whose message starts with M6_*.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const OPERATIONS = ['preflight', 'apply-004', 'apply-schema', 'plan-import', 'apply-import', 'rollback-import', 'rollback-schema', 'provision-intake']
export const MUTATING = new Set(['apply-004', 'apply-schema', 'apply-import', 'rollback-import', 'rollback-schema', 'provision-intake'])
export const GROUPS = ['prices', 'voucher']
const fail = (code, detail = '') => { throw new Error(detail ? `${code}:${detail}` : code) }
export const sha256 = (data) => createHash('sha256').update(data).digest('hex')
export const sha256File = (file) => sha256(readFileSync(file))

export function loadAllowlist(file) { const list = JSON.parse(readFileSync(file, 'utf8')); if (list.schema !== 1) fail('M6_ALLOWLIST_SCHEMA'); return list }

/** Every pinned file must exist and match its sha256 byte for byte (CRLF/whitespace changes count). Returns the verified relative paths. */
export function verifyPinned(root, pins) {
  const checked = []
  for (const pinned of pins) {
    const abs = path.resolve(root, pinned.file)
    if (!abs.startsWith(path.resolve(root) + path.sep)) fail('M6_PATH_OUTSIDE_REPO', pinned.file)
    let actual; try { actual = sha256File(abs) } catch { fail('M6_PINNED_FILE_MISSING', pinned.file) }
    if (actual !== pinned.sha256) fail('M6_CHECKSUM_MISMATCH', pinned.file)
    checked.push(pinned.file)
  }
  return checked
}
export const pinsFor = (list, operation, group) => {
  if (list.sql[operation]) return list.sql[operation]
  if (['plan-import', 'apply-import'].includes(operation)) return [list.scope_index, list.planner, ...list.lanes.filter((l) => l.group === group).flatMap((l) => [l.csv, ...(l.approval ? [l.approval] : [])])]
  return []
}

export function assertGo({ operation, approvedSha, githubSha, group, planSetSha256 }) {
  if (!OPERATIONS.includes(operation)) fail('M6_OPERATION_NOT_ALLOWED', operation)
  if (!/^[0-9a-f]{40}$/.test(approvedSha ?? '')) fail('M6_APPROVED_SHA_INVALID')
  if (approvedSha !== githubSha) fail('M6_APPROVED_SHA_NOT_CURRENT_MAIN')
  if (['plan-import', 'apply-import'].includes(operation) && !GROUPS.includes(group)) fail('M6_GROUP_NOT_ALLOWED', group)
  if (operation === 'apply-import' && !/^[0-9a-f]{64}$/.test(planSetSha256 ?? '')) fail('M6_PLAN_SET_SHA_REQUIRED')
}

/** The mutating operations need a FRESH, successful backup run that included the encrypted dump AND the isolated restore rehearsal. */
export function assertBackupEvidence(evidence, backup, now = new Date()) {
  if (!evidence || typeof evidence !== 'object') fail('M6_BACKUP_EVIDENCE_MISSING')
  if (evidence.path !== backup.workflow) fail('M6_BACKUP_WRONG_WORKFLOW')
  if (evidence.head_branch !== 'main') fail('M6_BACKUP_NOT_FROM_MAIN')
  if (evidence.conclusion !== 'success') fail('M6_BACKUP_NOT_SUCCESSFUL')
  if (!evidence.steps?.[backup.backup_step]) fail('M6_BACKUP_DID_NOT_DUMP')            // a `probe` run skips the dump step
  if (evidence.jobs?.[backup.restore_job] !== 'success') fail('M6_BACKUP_RESTORE_NOT_PROVEN')
  const done = Date.parse(evidence.updated_at)
  if (!Number.isFinite(done)) fail('M6_BACKUP_TIME_UNKNOWN')
  const ageMinutes = (now.getTime() - done) / 60000
  if (ageMinutes < 0) fail('M6_BACKUP_TIME_IN_FUTURE')
  if (ageMinutes > backup.max_age_minutes) fail('M6_BACKUP_TOO_OLD', `${Math.round(ageMinutes)}min>${backup.max_age_minutes}min`)
  return Math.round(ageMinutes)
}

export function assertTarget(contract, target, { testMode = false } = {}) {
  if (!contract) fail('M6_TARGET_CONTRACT_MISSING')
  const exact = contract.project_name === target.project_name && contract.region === target.region && contract.environment === target.environment && Number(contract.hard_database_ceiling_bytes) === target.ceiling_bytes
  if (!exact) fail('M6_TARGET_NOT_PRODUCTION_CONTRACT')
  if (!(contract.production_data_allowed === true && contract.production_writes_allowed === true)) fail('M6_PRODUCTION_WRITES_NOT_ALLOWED')
  void testMode
}
/** The database URL must name the Production project (pooler user `role.<ref>` or host `db.<ref>.supabase.co`); never anything else. */
export function assertProductionHost(databaseUrl, ref) {
  let url; try { url = new URL(databaseUrl) } catch { fail('M6_DATABASE_URL_INVALID') }
  if (!(decodeURIComponent(url.username).endsWith(`.${ref}`) || url.hostname.includes(ref))) fail('M6_DATABASE_NOT_PRODUCTION_PROJECT')
}
export function assertHeadroom(sizeBytes, ceilingBytes, minBytes) { if (!(Number(ceilingBytes) - Number(sizeBytes) >= minBytes)) fail('M6_HEADROOM_BELOW_MINIMUM') }
export function assertCapabilities(caps, effectiveRole, operation) {
  if (caps.effective_role !== effectiveRole) fail('M6_OPERATOR_ROLE_MISMATCH', `${caps.effective_role}!=${effectiveRole}`)
  if (!caps.bypassrls) fail('M6_OPERATOR_NEEDS_BYPASSRLS')                               // products has FORCED row level security
  if (['apply-schema', 'provision-intake', 'rollback-schema'].includes(operation) && !caps.createrole) fail('M6_OPERATOR_NEEDS_CREATEROLE')
}

/** One identity for a whole group of plans: sorted lane ids + plan shas. The Owner approves THIS value at the checkpoint. */
export const planSetSha = (plans) => sha256(plans.slice().sort((a, b) => a.lane.localeCompare(b.lane)).map((p) => `${p.lane}:${p.plan_sha}`).join('\n'))
export function assertExpectedCounts(group, plans, expected, { resume = false } = {}) {
  const rows = (mode) => plans.filter((p) => mode.includes(p.mode)).reduce((n, p) => n + p.rows, 0)
  if (group === 'prices') {
    const stop = plans.filter((p) => p.stop_reasons.length); if (stop.length) fail('M6_PLAN_STOPPED', stop.map((p) => `${p.lane}:${p.stop_reasons.join('+')}`).join(','))
    const priced = rows(['archived-direct', 'candidates', 'baseline']), status = rows(['status'])
    if (resume ? priced > expected.prices.rows : priced !== expected.prices.rows) fail('M6_PRICE_ROWS_NOT_APPROVED', String(priced))
    if (!resume && plans.filter((p) => ['archived-direct', 'candidates', 'baseline'].includes(p.mode)).length !== expected.prices.lanes) fail('M6_PRICE_LANES_NOT_COMPLETE')
    if (resume ? status > expected.status.rows : status !== expected.status.rows) fail('M6_STATUS_ROWS_NOT_APPROVED', String(status))
  } else {
    const stop = plans.filter((p) => p.stop_reasons.length); if (stop.length) fail('M6_PLAN_STOPPED', stop.map((p) => `${p.lane}:${p.stop_reasons.join('+')}`).join(','))
    const vouchers = rows(['voucher'])
    if (resume ? vouchers > expected.voucher.rows : vouchers !== expected.voucher.rows) fail('M6_VOUCHER_ROWS_NOT_APPROVED', String(vouchers))
  }
}
export function assertPlanSetMatches(approved, actual) { if (approved !== actual) fail('M6_PLAN_SET_CHANGED', 'the database or the package changed since the plan the Owner approved: plan again') }
