// #470 — voucher lane (Owner 24/11, TL 7128797116 §A). DPG accepts the Hita exact-SKU online voucher AMOUNT for the SKUs the Owner pinned (stored evidence in package #485,
// voucher-holds.csv). Pure functions, no network, no database. This lane runs AFTER the price lanes: it only fills `online_voucher_amount_vnd` on rows that already hold a
// PRICE_VERIFIED price, keeps the price's own checked-at (a voucher is not a new price check) and refuses anything not pinned:
//   * the approval pins the CSV sha256 + the exact id set (equality both directions) + the ids that must stay NULL (29 Owner-requested TOTO + the 2 INAX promotion-held rows);
//   * the stored evidence amount must be an integer > 0 and strictly below the selling price (promotion ?? regular) of the row as it is in the database;
//   * identity (id/sku/brand/category/state/version) must equal the live row; an existing different voucher is never overwritten;
//   * no advertising text is copied: only SKU + amount + source URL/time are stored.
import { parseCsv } from './quality-gate-core.mts'
import { BRANDS, BYTES_PER_CHANGED_ROW, DB_CEILING_BYTES, DEFAULT_BATCH_SIZE, ISO, PRODUCTION_TARGET, SAFETY_MARGIN_BYTES, SANITARY_CATEGORY_ID, SKU_SAFE, canonOf, same, sha256,
  type BrandKey, type Canon, type DbRow, type Plan, type PlanRow, type PlanState } from './prod-import-core.mts'

export type VoucherApproval = { approved_by: 'Owner'; approval_ref: string; rule_ref: string; csv_sha256: string; approved_ids: number[]; hold_null_ids: number[] }
export type VoucherInput = { csvText: string; expectedCsvSha256: string; approval: VoucherApproval | null; candidateSha: string; db: DbRow[]; dbSizeBytes: number; brand: BrandKey; state: PlanState; batchSize?: number }
export const VOUCHER_COLUMNS = ['brand', 'dpg_id', 'sku', 'is_active', 'voucher_vnd', 'source_checked_at_utc', 'source_url'] as const
export const VOUCHER_BASIS = 'DPG_VOUCHER_FROM_STORED_HITA_EXACT_SKU_EVIDENCE'
const PDP_URL = /^https:\/\/hita\.com\.vn\/[a-z0-9-]+-\d+\.html$/

export function buildVoucherPlan(input: VoucherInput): Plan {
  const stop: string[] = [], csvSha256 = sha256(input.csvText), a = input.approval
  if (!/^[0-9a-f]{64}$/.test(input.expectedCsvSha256)) stop.push('EXPECTED_CSV_SHA256_MISSING_OR_MALFORMED')
  else if (csvSha256 !== input.expectedCsvSha256) stop.push(`CSV_SHA256_MISMATCH expected=${input.expectedCsvSha256} actual=${csvSha256}`)
  if (!/^[0-9a-f]{40}$/.test(input.candidateSha)) stop.push('CANDIDATE_SHA_MISSING_OR_MALFORMED')
  const brand = input.brand, state = input.state, brandId = BRANDS[brand]?.id ?? 0, wantActive = state === 'active'
  if (!(brand in BRANDS)) stop.push('BRAND_NOT_APPROVED')
  const ids = new Set<number>(), held = new Set<number>()
  if (!a) stop.push('OWNER_APPROVAL_MISSING')
  else {
    if (a.approved_by !== 'Owner' || !a.approval_ref || !a.rule_ref) stop.push('OWNER_APPROVAL_INCOMPLETE')
    if (a.csv_sha256 !== csvSha256) stop.push('OWNER_APPROVAL_FOR_A_DIFFERENT_CSV')
    const ok = (v: unknown) => Array.isArray(v) && v.every(i => Number.isSafeInteger(i)) && new Set(v).size === v.length
    if (!ok(a.approved_ids) || !ok(a.hold_null_ids)) stop.push('OWNER_APPROVAL_IDS_INVALID')
    else { a.approved_ids.forEach(i => ids.add(i)); a.hold_null_ids.forEach(i => held.add(i)) }
  }
  const table = parseCsv(input.csvText), header = (table[0] ?? []).map(h => h.trim()), col = Object.fromEntries(header.map((h, i) => [h, i]))
  const missing = VOUCHER_COLUMNS.filter(c => !(c in col)); if (missing.length) stop.push(`VOUCHER_CSV_MISSING_COLUMNS ${missing.join(',')}`)
  const data = missing.length ? [] : table.slice(1).map(r => Object.fromEntries(VOUCHER_COLUMNS.map(c => [c, (r[col[c]] ?? '').trim()])) as Record<(typeof VOUCHER_COLUMNS)[number], string>)
  const inCsv = new Set(data.map(r => Number(r.dpg_id)))
  if (a && (inCsv.size !== data.length || inCsv.size !== ids.size || [...inCsv].some(i => !ids.has(i)))) stop.push('OWNER_APPROVAL_SCOPE_MISMATCH')
  if ([...ids].some(i => held.has(i))) stop.push('VOUCHER_ID_IS_HELD_NULL')
  const db = new Map(input.db.map(r => [r.id, r])), skipped: Record<string, number> = {}, skip = (c: string) => { skipped[c] = (skipped[c] ?? 0) + 1 }
  const counts = { in_csv: data.length, to_change: 0, unchanged: 0 }, rows: PlanRow[] = []
  if (!stop.length) for (const r of data) {
    const id = Number(r.dpg_id), active = r.is_active === 'true', bad = (c: string) => { stop.push(`${c} id=${r.dpg_id}`) }
    if (r.brand.toLowerCase() !== brand || active !== wantActive) { skip('OTHER_BRAND_OR_STATE'); continue }
    const cur = db.get(id)
    if (!cur || cur.sku !== r.sku || cur.category_id !== SANITARY_CATEGORY_ID || cur.brand_id !== brandId || cur.is_active !== active || !SKU_SAFE.test(r.sku) || !Number.isSafeInteger(cur.version) || (cur.version as number) < 1) { bad('IDENTITY_MISMATCH'); continue }
    const before = canonOf(cur), amount = /^[1-9]\d{0,12}$/.test(r.voucher_vnd) ? Number(r.voucher_vnd) : null
    if (amount === null) { bad('VOUCHER_AMOUNT_INVALID'); continue }
    if (!PDP_URL.test(r.source_url) || !ISO.test(r.source_checked_at_utc)) { bad('VOUCHER_EVIDENCE_INVALID'); continue }
    if (before.status !== 'PRICE_VERIFIED' || before.regular === null || !cur.canonical_price_checked_at) { bad('VOUCHER_ROW_NOT_PRICED_YET'); continue }   // price lanes first
    if (amount >= (before.promo ?? before.regular)) { bad('VOUCHER_NOT_BELOW_SELLING_PRICE'); continue }
    if (before.voucher !== null && before.voucher !== amount) { skip('VOUCHER_DOES_NOT_OVERRIDE_EXISTING'); continue }
    const after: Canon = { ...before, voucher: amount }
    if (same(before, after)) { counts.unchanged++; continue }
    const checked = new Date(cur.canonical_price_checked_at).toISOString()   // the PRICE's check time is kept
    counts.to_change++
    rows.push({ id, sku: r.sku, is_active: active, klass: VOUCHER_BASIS, before, after, beforeCheckedAt: checked, version: cur.version as number, checkedAt: checked, sourceUrl: r.source_url,
      provenance: { basis: VOUCHER_BASIS, voucher_source_checked_at_utc: r.source_checked_at_utc, approval_ref: a?.approval_ref ?? null, rule_ref: a?.rule_ref ?? null } })
  }
  rows.sort((x, y) => x.id - y.id)
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE, growth = rows.length * BYTES_PER_CHANGED_ROW, projected = input.dbSizeBytes + growth
  if (projected > DB_CEILING_BYTES - SAFETY_MARGIN_BYTES) stop.push(`DB_HEADROOM_INSUFFICIENT projected=${projected} limit=${DB_CEILING_BYTES - SAFETY_MARGIN_BYTES}`)
  const batches: PlanRow[][] = []; for (let i = 0; i < rows.length; i += batchSize) batches.push(rows.slice(i, i + batchSize))
  const planSha = sha256(JSON.stringify({ source: VOUCHER_BASIS, csvSha256, approval: a?.approval_ref, ids: [...ids].sort((x, y) => x - y), held: [...held].sort((x, y) => x - y), candidateSha: input.candidateSha, batchSize, brand, brandId, state,
    target: PRODUCTION_TARGET, rows: rows.map(r => [r.id, r.sku, r.version, r.before, r.beforeCheckedAt, r.after, r.checkedAt]) }))
  const summary = { ...counts, skipped_by_reason: skipped, brand, brand_id: brandId, state, price_basis: VOUCHER_BASIS, approval_ref: a?.approval_ref ?? null, batches: batches.length, batch_size: batchSize,
    db_size_bytes: input.dbSizeBytes, est_growth_bytes: growth, projected_db_bytes: projected, headroom_after_bytes: DB_CEILING_BYTES - projected }
  return { csvSha256, candidateSha: input.candidateSha, planSha, batchSize, brandId, brand, state, releaseBinding: `${input.candidateSha}:${csvSha256}:${planSha}`, summary, stopReasons: [...new Set(stop)], rows, batches,
    source: 'DPG_VOUCHER_FROM_STORED_EVIDENCE', approvalRef: a?.approval_ref }
}
