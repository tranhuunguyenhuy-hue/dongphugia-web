// #470 — Owner-approved INAX active BASELINE cohort (547 SKUs; TL 7128033322 item 2, Owner #443 7127916878). Pure functions, no network, no database.
// These rows carry review_status STALE_PILOT_BASELINE_448, which the normal contract classifies UNRESOLVED (skipped). This is NOT a switch that turns UNRESOLVED into prices:
// the ONLY way in is the Owner decision file `inax-baseline-owner-decision.json` + its pinned review CSV, and every check below fails closed:
//   * the decision pins the CSV sha256 and the EXACT id set (equality both directions, no extras, no missing); wrong brand/state/category/SKU/identity => the plan STOPS;
//   * evidence must be the stored one (status/baseline_status EXACT, price_source HITA_BASELINE_448, direct_freshness NOT_RECONFIRMED, exact Hita SKU = DPG SKU, PDP URL, VND);
//   * what is written is the Owner-proposed value: regular = baseline regular, promotion = baseline promotion (545 rows), or NONE for the 2 deep-discount rows whose promotion terms
//     are not confirmed (regular only); the online voucher is always NULL;
//   * the source timestamp is kept as is (never re-stamped, never "now"); an Offer validity that has passed => HOLD (the plan stops);
//   * stored prices, newer Admin edits and any state other than the pinned live identity are never overwritten.
import { parseCsv } from './quality-gate-core.mts'
import { BRANDS, BYTES_PER_CHANGED_ROW, DB_CEILING_BYTES, DEFAULT_BATCH_SIZE, ISO, PRODUCTION_TARGET, SAFETY_MARGIN_BYTES, SANITARY_CATEGORY_ID, SKU_SAFE, canonOf, same, sha256,
  type Canon, type DbRow, type Plan, type PlanRow } from './prod-import-core.mts'

export type BaselineDecision = { approved_by: 'Owner'; approval_ref: string; rule_ref: string; review_csv_sha256: string; scope_ids: number[] }
export type BaselineInput = { csvText: string; expectedCsvSha256: string; decision: BaselineDecision | null; candidateSha: string; db: DbRow[]; dbSizeBytes: number; now: Date; batchSize?: number; brand?: string; state?: string }
const COLUMNS = ['brand', 'dpg_id', 'sku', 'category', 'is_active', 'hita_exact_sku', 'hita_url', 'regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd', 'currency', 'source_checked_at_utc',
  'price_valid_until', 'status', 'review_status', 'price_source', 'baseline_status', 'proposed_regular_price_vnd', 'proposed_promotional_price_vnd', 'proposed_online_voucher_amount_vnd', 'price_basis',
  'direct_freshness', 'exception_reason'] as const
const PDP_URL = /^https:\/\/hita\.com\.vn\/[a-z0-9-]+-\d+\.html$/
const int = (s: string) => (/^[1-9]\d{0,12}$/.test(s) ? Number(s) : null)
export const BASELINE_BASIS = 'OWNER_ACCEPTED_ARCHIVED_INAX_BASELINE'
const NO_PROMO_REASON = 'DEEP_PROMO_TERMS_NOT_CONFIRMED'

export function buildBaselinePlan(input: BaselineInput): Plan {
  const stop: string[] = []
  const csvSha256 = sha256(input.csvText), d = input.decision
  if (!/^[0-9a-f]{64}$/.test(input.expectedCsvSha256)) stop.push('EXPECTED_CSV_SHA256_MISSING_OR_MALFORMED')
  else if (csvSha256 !== input.expectedCsvSha256) stop.push(`CSV_SHA256_MISMATCH expected=${input.expectedCsvSha256} actual=${csvSha256}`)
  if (!/^[0-9a-f]{40}$/.test(input.candidateSha)) stop.push('CANDIDATE_SHA_MISSING_OR_MALFORMED')
  if ((input.brand ?? 'inax') !== 'inax' || (input.state ?? 'active') !== 'active') stop.push('BASELINE_LANE_IS_INAX_ACTIVE_ONLY')
  const ids = new Set<number>()
  if (!d) stop.push('OWNER_DECISION_MISSING')
  else {
    if (d.approved_by !== 'Owner' || !d.approval_ref || !d.rule_ref) stop.push('OWNER_DECISION_INCOMPLETE')
    if (d.review_csv_sha256 !== csvSha256) stop.push('OWNER_DECISION_FOR_A_DIFFERENT_CSV')
    if (!Array.isArray(d.scope_ids) || d.scope_ids.some(i => !Number.isSafeInteger(i)) || new Set(d.scope_ids).size !== d.scope_ids.length) stop.push('OWNER_DECISION_IDS_INVALID')
    else d.scope_ids.forEach(i => ids.add(i))
  }
  const brandId = BRANDS.inax.id
  const table = parseCsv(input.csvText), header = (table[0] ?? []).map(h => h.trim()), col = Object.fromEntries(header.map((h, i) => [h, i]))
  const missing = COLUMNS.filter(c => !(c in col)); if (missing.length) stop.push(`BASELINE_CSV_MISSING_COLUMNS ${missing.join(',')}`)
  const data = missing.length ? [] : table.slice(1).map(r => Object.fromEntries(COLUMNS.map(c => [c, (r[col[c]] ?? '').trim()])) as Record<(typeof COLUMNS)[number], string>)
  const inCsv = new Set(data.map(r => Number(r.dpg_id)))
  if (d && (inCsv.size !== data.length || inCsv.size !== ids.size || [...inCsv].some(i => !ids.has(i)))) stop.push('OWNER_DECISION_SCOPE_MISMATCH')   // exact set, no extras, no missing, no duplicates
  const db = new Map(input.db.map(r => [r.id, r]))
  const skipped: Record<string, number> = {}, skip = (c: string) => { skipped[c] = (skipped[c] ?? 0) + 1 }
  const counts = { in_csv: data.length, to_change: 0, unchanged: 0, regular_only: 0, regular_and_promo: 0 }
  const rows: PlanRow[] = []
  if (!stop.length) for (const r of data) {
    const id = Number(r.dpg_id), cur = db.get(id), bad = (c: string) => { stop.push(`${c} id=${r.dpg_id}`) }
    if (!cur || cur.sku !== r.sku || cur.category_id !== SANITARY_CATEGORY_ID || cur.brand_id !== brandId || cur.is_active !== true || !SKU_SAFE.test(r.sku) || r.category !== 'thiet-bi-ve-sinh'
      || r.brand !== 'INAX' || r.is_active !== 'true' || !Number.isSafeInteger(cur.version) || (cur.version as number) < 1) { bad('IDENTITY_MISMATCH'); continue }
    // stored evidence, not a fresh claim
    if (r.status !== 'EXACT' || r.baseline_status !== 'EXACT' || r.review_status !== 'STALE_PILOT_BASELINE_448' || r.price_source !== 'HITA_BASELINE_448' || r.price_basis !== BASELINE_BASIS
      || r.direct_freshness !== 'NOT_RECONFIRMED') { bad('BASELINE_EVIDENCE_LABEL_MISMATCH'); continue }
    if (!r.hita_exact_sku || r.hita_exact_sku !== r.sku || !PDP_URL.test(r.hita_url) || r.currency !== 'VND') { bad('BASELINE_EXACT_SKU_OR_URL_OR_CURRENCY_INVALID'); continue }
    const regular = int(r.regular_price_vnd), promo = r.promotional_price_vnd === '' ? null : int(r.promotional_price_vnd)
    if (regular === null || (r.promotional_price_vnd !== '' && promo === null) || (promo !== null && promo >= regular)) { bad('BASELINE_PRICE_INVALID'); continue }
    if (int(r.proposed_regular_price_vnd) !== regular || r.proposed_online_voucher_amount_vnd !== '') { bad('BASELINE_PROPOSAL_MISMATCH'); continue }
    const proposedPromo = r.proposed_promotional_price_vnd === '' ? null : int(r.proposed_promotional_price_vnd)
    if (r.proposed_promotional_price_vnd !== '' && proposedPromo !== promo) { bad('BASELINE_PROPOSAL_MISMATCH'); continue }
    if (proposedPromo === null && promo !== null && r.exception_reason !== NO_PROMO_REASON) { bad('BASELINE_PROMO_DROPPED_WITHOUT_REASON'); continue }   // only the 2 documented rows may lose the promotion
    if (!ISO.test(r.source_checked_at_utc) || Date.parse(r.source_checked_at_utc) > input.now.getTime() + 60_000) { bad('BASELINE_CHECKED_AT_INVALID'); continue }
    const until = /^\d{4}-\d{2}-\d{2}$/.test(r.price_valid_until) ? Date.parse(r.price_valid_until + 'T23:59:59Z') : NaN
    if (!Number.isFinite(until) || until < input.now.getTime()) { bad('BASELINE_OFFER_EXPIRED_HOLD'); continue }          // expired/unknown validity: HOLD, never imported
    const before = canonOf(cur)
    if (before.status === 'PRICE_VERIFIED' || before.regular !== null) { skip('BASELINE_DOES_NOT_OVERRIDE_STORED_PRICE'); continue }
    const beforeCheckedAt = cur.canonical_price_checked_at ? new Date(cur.canonical_price_checked_at).toISOString() : null
    if (beforeCheckedAt && Date.parse(beforeCheckedAt) > Date.parse(r.source_checked_at_utc)) { skip('NEWER_DB_EDIT'); continue }
    const after: Canon = { status: 'PRICE_VERIFIED', regular, promo: proposedPromo, voucher: null }
    if (same(before, after)) { counts.unchanged++; continue }
    counts.to_change++; if (proposedPromo === null) counts.regular_only++; else counts.regular_and_promo++
    rows.push({ id, sku: r.sku, is_active: true, klass: BASELINE_BASIS, before, after, beforeCheckedAt, version: cur.version as number, checkedAt: r.source_checked_at_utc, sourceUrl: r.hita_url,
      provenance: { basis: BASELINE_BASIS, not_reconfirmed: true, price_source: r.price_source, source_checked_at_utc: r.source_checked_at_utc, price_valid_until: r.price_valid_until, promotion_dropped: proposedPromo === null && promo !== null,
        approval_ref: d?.approval_ref ?? null, rule_ref: d?.rule_ref ?? null } })
  }
  rows.sort((x, y) => x.id - y.id)
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE, growth = rows.length * BYTES_PER_CHANGED_ROW, projected = input.dbSizeBytes + growth
  if (projected > DB_CEILING_BYTES - SAFETY_MARGIN_BYTES) stop.push(`DB_HEADROOM_INSUFFICIENT projected=${projected} limit=${DB_CEILING_BYTES - SAFETY_MARGIN_BYTES}`)
  const batches: PlanRow[][] = []; for (let i = 0; i < rows.length; i += batchSize) batches.push(rows.slice(i, i + batchSize))
  const planSha = sha256(JSON.stringify({ source: BASELINE_BASIS, csvSha256, approval: d?.approval_ref, ids: [...ids].sort((a, b) => a - b), candidateSha: input.candidateSha, batchSize, brandId, target: PRODUCTION_TARGET,
    rows: rows.map(r => [r.id, r.sku, r.version, r.before, r.beforeCheckedAt, r.after, r.checkedAt]) }))
  const summary = { ...counts, skipped_by_reason: skipped, brand: 'inax', brand_id: brandId, state: 'active', price_basis: BASELINE_BASIS, approval_ref: d?.approval_ref ?? null, batches: batches.length, batch_size: batchSize,
    db_size_bytes: input.dbSizeBytes, est_growth_bytes: growth, projected_db_bytes: projected, headroom_after_bytes: DB_CEILING_BYTES - projected }
  return { csvSha256, candidateSha: input.candidateSha, planSha, batchSize, brandId, brand: 'inax', state: 'active', releaseBinding: `${input.candidateSha}:${csvSha256}:${planSha}`, summary, stopReasons: [...new Set(stop)], rows, batches,
    source: 'OWNER_ACCEPTED_ARCHIVED_INAX_BASELINE', approvalRef: d?.approval_ref }
}
