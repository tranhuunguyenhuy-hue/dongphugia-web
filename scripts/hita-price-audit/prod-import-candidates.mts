// #470 — Owner-accepted historical price CANDIDATES (TL note 7127074691 / Owner rule #443 7127072994). Pure functions, no network, no database.
// A candidate is a single historical Hita price whose brand is evidenced only indirectly. It may be imported ONLY when ALL of these hold:
//   * an Owner approval document pins the candidate CSV sha256 and lists the exact approved dpg_ids (no approval => nothing is planned, the plan STOPS);
//   * exact full SKU (dpg_sku = source_sku = search_sku), VND, one price only (no promotion / voucher), PDP price = Offer price = CSV price;
//   * no Hita page id shared with another SKU (collision), brand/state/category identity equals the live row;
//   * the price is still fresh for use (default 7 days, the same threshold as Admin re-activation) — the source timestamp is NEVER changed or extended;
//   * it never overwrites a direct Hita-verified price and never an Admin edit made after the source timestamp.
// The price goes ONLY to regular_price_vnd (promotion/voucher NULL) with status PRICE_VERIFIED and canonical_price_checked_at = the SOURCE time.
// Provenance (basis OWNER_ACCEPTED_CANDIDATE, source URL/time, match class/confidence/rule, approval reference) lives in the plan, ledger and manifest — never as a
// "directly verified by Hita" claim. Gap: the database has no per-row provenance column (see release-manifest §10); adding one is a separate small decision.
import { parseCsv } from './quality-gate-core.mts'
import { BRANDS, DB_CEILING_BYTES, PRODUCTION_TARGET, BYTES_PER_CHANGED_ROW, DEFAULT_BATCH_SIZE, ISO, SAFETY_MARGIN_BYTES, SANITARY_CATEGORY_ID, SKU_SAFE, canonOf, num, same, sha256,
  type BrandKey, type Canon, type DbRow, type Plan, type PlanRow, type PlanState } from './prod-import-core.mts'

/** Two layouts exist in the Codex package: INAX (dpg_sku/offer_price/matched_hita_product_id/rule_version) and TOTO (sku/offer_vnd/review_reason, Hita page id only inside source_url).
 * Both are normalised to ONE shape; a column that is missing in both spellings stops the plan. */
const REQUIRED = ['brand', 'category', 'is_active', 'dpg_id', 'source_sku', 'historical_regular_price_vnd', 'historical_promotional_price_vnd', 'historical_online_voucher_amount_vnd', 'currency', 'source_url',
  'source_checked_at_utc', 'pdp_selling', 'review_status', 'search_sku', 'match_type', 'confidence'] as const
const ALIASES: Record<string, readonly string[]> = { dpg_sku: ['dpg_sku', 'sku'], offer_price: ['offer_price', 'offer_vnd'] }
export const CANDIDATE_COLUMNS = [...REQUIRED, ...Object.keys(ALIASES), 'matched_hita_product_id', 'rule_version'] as const
type CandRow = Record<(typeof CANDIDATE_COLUMNS)[number], string>
/** Owner approval document: the Owner's decision, referenced by id. It is data; it authorises nothing outside this planner (production writes still need the GO). */
export type CandidateApproval = { approved_by: 'Owner'; approval_ref: string; rule_ref: string; candidate_csv_sha256: string; approved_ids: number[] }
export type CandidateInput = {
  csvText: string; expectedCsvSha256: string; approval: CandidateApproval | null; candidateSha: string; db: DbRow[]; dbSizeBytes: number
  brand: BrandKey; state: PlanState; now: Date; maxAgeHours?: number; batchSize?: number
}
export const CANDIDATE_MAX_AGE_HOURS = 7 * 24

const money = (s: string) => { const digits = s.replace(/[^\d]/g, ''); return /^[1-9]\d{0,12}$/.test(digits) ? Number(digits) : null }
const decimalOffer = (s: string) => (/^\d+(\.0+)?$/.test(s) ? money(s.split('.')[0]) : null)

export function buildCandidatePlan(input: CandidateInput): Plan {
  const stop: string[] = []
  const csvSha256 = sha256(input.csvText)
  if (!/^[0-9a-f]{64}$/.test(input.expectedCsvSha256)) stop.push('EXPECTED_CSV_SHA256_MISSING_OR_MALFORMED')
  else if (csvSha256 !== input.expectedCsvSha256) stop.push(`CSV_SHA256_MISMATCH expected=${input.expectedCsvSha256} actual=${csvSha256}`)
  if (!/^[0-9a-f]{40}$/.test(input.candidateSha)) stop.push('CANDIDATE_SHA_MISSING_OR_MALFORMED')
  const a = input.approval
  const approvedIds = new Set<number>()
  if (!a) stop.push('OWNER_APPROVAL_MISSING')
  else {
    if (a.approved_by !== 'Owner' || !a.approval_ref || !a.rule_ref) stop.push('OWNER_APPROVAL_INCOMPLETE')
    if (a.candidate_csv_sha256 !== csvSha256) stop.push('OWNER_APPROVAL_FOR_A_DIFFERENT_CSV')
    if (!Array.isArray(a.approved_ids) || a.approved_ids.some(i => !Number.isSafeInteger(i))) stop.push('OWNER_APPROVAL_IDS_INVALID')
    else a.approved_ids.forEach(i => approvedIds.add(i))
  }
  const brand = input.brand, state = input.state, brandId = BRANDS[brand]?.id ?? 0, wantActive = state === 'active'
  if (!(brand in BRANDS)) stop.push('BRAND_NOT_APPROVED')
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE
  const maxAgeMs = (input.maxAgeHours ?? CANDIDATE_MAX_AGE_HOURS) * 3600_000

  const table = parseCsv(input.csvText)
  const header = table[0] ?? []
  const col = Object.fromEntries(header.map((h, i) => [h.trim(), i]))
  const pick = (r: string[], names: readonly string[]) => { for (const n of names) if (n in col) return (r[col[n]] ?? '').trim(); return '' }
  const missing = [...REQUIRED, ...Object.keys(ALIASES)].filter(c => !(ALIASES[c] ?? [c]).some(n => n in col)); if (missing.length) stop.push(`CANDIDATE_CSV_MISSING_COLUMNS ${missing.join(',')}`)
  const data: CandRow[] = missing.length ? [] : table.slice(1).map(r => {
    const o: Record<string, string> = {}
    for (const c of [...REQUIRED, ...Object.keys(ALIASES)]) o[c] = pick(r, ALIASES[c] ?? [c])
    o.matched_hita_product_id = pick(r, ['matched_hita_product_id']) || /-(\d+)\.html$/.exec(o.source_url)?.[1] || ''   // TOTO layout: the Hita page id is the URL suffix
    o.rule_version = pick(r, ['rule_version', 'review_reason'])
    return o as CandRow
  })
  const hitaIdOwners = new Map<string, Set<string>>()
  for (const r of data) { const set = hitaIdOwners.get(r.matched_hita_product_id) ?? new Set<string>(); set.add(r.dpg_id); hitaIdOwners.set(r.matched_hita_product_id, set) }

  const db = new Map(input.db.map(r => [r.id, r]))
  const skipped: Record<string, number> = {}
  const skip = (code: string) => { skipped[code] = (skipped[code] ?? 0) + 1 }
  const counts = { in_csv: data.length, not_approved: 0, to_change: 0, unchanged: 0, blocked_identity: 0 }
  const rows: PlanRow[] = []
  for (const r of data) {
    const id = Number(r.dpg_id), active = r.is_active === 'true'
    if (r.brand.toLowerCase() !== brand || active !== wantActive) { skip('OTHER_BRAND_OR_STATE'); continue }
    if (!approvedIds.has(id)) { counts.not_approved++; continue }
    const cur = db.get(id)
    if (!cur || cur.sku !== r.dpg_sku || cur.category_id !== SANITARY_CATEGORY_ID || cur.brand_id !== brandId || cur.is_active !== active || !SKU_SAFE.test(r.dpg_sku)
      || r.category !== 'thiet-bi-ve-sinh' || !Number.isSafeInteger(cur.version) || (cur.version as number) < 1) {
      counts.blocked_identity++; stop.push(`IDENTITY_MISMATCH id=${r.dpg_id} sku=${r.dpg_sku.slice(0, 30)}`); continue
    }
    const regular = money(r.historical_regular_price_vnd)
    if (r.review_status !== 'HISTORICAL_PRICE_CANDIDATE') { skip('CANDIDATE_REVIEW_STATUS'); continue }
    if (!r.match_type.startsWith('EXACT_SKU') || !['MODERATE', 'HIGH'].includes(r.confidence)) { skip('CANDIDATE_MATCH_TOO_WEAK'); continue }
    if (r.dpg_sku !== r.source_sku || r.dpg_sku !== r.search_sku) { skip('CANDIDATE_SKU_NOT_EXACT'); continue }
    if (r.currency !== 'VND' || regular === null) { skip('CANDIDATE_PRICE_INVALID'); continue }
    if (r.historical_promotional_price_vnd !== '' || r.historical_online_voucher_amount_vnd !== '') { skip('CANDIDATE_NOT_SINGLE_PRICE'); continue }
    if (money(r.pdp_selling) !== regular || decimalOffer(r.offer_price) !== regular) { skip('CANDIDATE_PRICE_SOURCES_DISAGREE'); continue }
    if ((hitaIdOwners.get(r.matched_hita_product_id)?.size ?? 0) !== 1 || !/^\d+$/.test(r.matched_hita_product_id)) { skip('CANDIDATE_HITA_ID_COLLISION'); continue }
    if (!ISO.test(r.source_checked_at_utc)) { skip('CANDIDATE_CHECKED_AT_INVALID'); continue }
    const age = input.now.getTime() - Date.parse(r.source_checked_at_utc)
    if (!(age >= 0) || age > maxAgeMs) { skip('CANDIDATE_STALE_REFRESH_BEFORE_USE'); continue }   // never re-stamped: it must be refreshed at the source
    const before = canonOf(cur)
    // A direct Hita-verified price (or any price) already stored is never replaced by an indirect candidate.
    if (before.status === 'PRICE_VERIFIED' || before.regular !== null) { skip('CANDIDATE_DOES_NOT_OVERRIDE_STORED_PRICE'); continue }
    const beforeCheckedAt = cur.canonical_price_checked_at ? new Date(cur.canonical_price_checked_at).toISOString() : null
    if (beforeCheckedAt && Date.parse(beforeCheckedAt) > Date.parse(r.source_checked_at_utc)) { skip('NEWER_DB_EDIT'); continue }
    const after: Canon = { status: 'PRICE_VERIFIED', regular, promo: null, voucher: null }
    if (same(before, after)) { counts.unchanged++; continue }
    counts.to_change++
    rows.push({ id, sku: r.dpg_sku, is_active: active, klass: 'OWNER_ACCEPTED_CANDIDATE', before, after, beforeCheckedAt, version: cur.version as number, checkedAt: r.source_checked_at_utc, sourceUrl: r.source_url,
      provenance: { basis: 'OWNER_ACCEPTED_CANDIDATE', not_direct_hita_verified: true, match_type: r.match_type, confidence: r.confidence, rule_version: r.rule_version, matched_hita_product_id: r.matched_hita_product_id,
        source_checked_at_utc: r.source_checked_at_utc, approval_ref: a?.approval_ref ?? null, rule_ref: a?.rule_ref ?? null } })
  }
  void num
  rows.sort((x, y) => x.id - y.id)
  const growth = rows.length * BYTES_PER_CHANGED_ROW, projected = input.dbSizeBytes + growth
  if (projected > DB_CEILING_BYTES - SAFETY_MARGIN_BYTES) stop.push(`DB_HEADROOM_INSUFFICIENT projected=${projected} limit=${DB_CEILING_BYTES - SAFETY_MARGIN_BYTES}`)
  const batches: PlanRow[][] = []
  for (let i = 0; i < rows.length; i += batchSize) batches.push(rows.slice(i, i + batchSize))
  const planSha = sha256(JSON.stringify({ source: 'OWNER_ACCEPTED_CANDIDATE', csvSha256, approval: a?.approval_ref, approvedIds: [...approvedIds].sort((x, y) => x - y), candidateSha: input.candidateSha, batchSize, brand, brandId, state,
    target: PRODUCTION_TARGET, maxAgeMs, rows: rows.map(r => [r.id, r.sku, r.version, r.before, r.beforeCheckedAt, r.after, r.checkedAt]) }))
  const summary = { ...counts, skipped_by_reason: skipped, brand, brand_id: brandId, state, price_basis: 'OWNER_ACCEPTED_CANDIDATE', approval_ref: a?.approval_ref ?? null, batches: batches.length, batch_size: batchSize,
    max_age_hours: maxAgeMs / 3600_000, db_size_bytes: input.dbSizeBytes, est_growth_bytes: growth, projected_db_bytes: projected, headroom_after_bytes: DB_CEILING_BYTES - projected }
  return { csvSha256, candidateSha: input.candidateSha, planSha, batchSize, brandId, brand, state, releaseBinding: `${input.candidateSha}:${csvSha256}:${planSha}`, summary, stopReasons: [...new Set(stop)], rows, batches,
    source: 'OWNER_ACCEPTED_CANDIDATE', approvalRef: a?.approval_ref }
}
