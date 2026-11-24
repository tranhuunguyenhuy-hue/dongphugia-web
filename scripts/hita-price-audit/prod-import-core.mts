// #470 Step 3b — Production price import PLANNER (pure functions; no network, no database, no psql).
// It can NOT write: it only turns an approved CSV + a read-only DB snapshot into reviewed SQL batches + a rollback ledger.
// Execution is a separate, manual operator step that needs an Owner GO naming the exact plan SHA (embedded in every batch).
import { createHash } from 'node:crypto'
import { summarise, validate, type InvRow } from './quality-gate-core.mts'

export const SANITARY_CATEGORY_ID = 1
export const DB_CEILING_BYTES = 367_001_600            // leo538 trigger: 350 MiB hard ceiling
export const SAFETY_MARGIN_BYTES = 8 * 1024 * 1024     // never plan to end closer than this to the ceiling
export const BYTES_PER_CHANGED_ROW = 2_115             // measured non-HOT update cost on products (heap+indexes), conservative
export const DEFAULT_BATCH_SIZE = 200
export type CanonStatus = 'PRICE_VERIFIED' | 'CONTACT_VERIFIED' | 'UNRESOLVED' | 'NOT_FOUND' | 'DISCONTINUED' | 'REVERIFY_REQUIRED'   // REVERIFY_REQUIRED is only ever a PRIOR state here (Admin 2C); the planner never writes it
export type Canon = { status: CanonStatus | null; regular: number | null; promo: number | null; voucher: number | null }
export type DbRow = { id: number; sku: string; category_id: number; brand_id?: number | null; is_active: boolean; version?: number; canonical_price_status?: string | null
  regular_price_vnd?: number | string | null; promotional_price_vnd?: number | string | null; online_voucher_amount_vnd?: number | string | null
  canonical_price_checked_at?: string | null }
/** Full prior state of a row: restored exactly by rollback (status, 3 prices, checked-at) and used as the optimistic basis (+ version). */
export type PlanRow = { id: number; sku: string; is_active: boolean; klass: string; before: Canon; after: Canon; beforeCheckedAt: string | null; version: number
  checkedAt: string; sourceUrl: string
  /** Where the price comes from when it is NOT a direct Hita-verified crawl row (Owner-accepted historical candidate): written to the ledger only. */
  provenance?: Record<string, unknown> }
/** Production identity the generated SQL refuses to run anywhere else (read-only audit 2026-11-24). Not a secret, not an approval. */
export const PRODUCTION_TARGET = { projectName: 'dongphugia-runtime', region: 'ap-southeast-1', environment: 'preview', ceilingBytes: DB_CEILING_BYTES } as const
/** Immutable brand identities (dpg_app.brands id + slug, read-only audit 2026-11-24: sanitary toto 2,057 active + 2,384 inactive; inax 1,653 active + 437 inactive).
 * One plan = ONE brand x ONE state. Plans/ledgers/checksums/rollbacks are never mixed across brands or states. */
export const BRANDS = { toto: { id: 1, slug: 'toto' }, inax: { id: 2, slug: 'inax' } } as const
export type BrandKey = keyof typeof BRANDS
export type PlanState = 'active' | 'inactive'
export type PlanSource = 'HITA_REVIEW' | 'OWNER_ACCEPTED_CANDIDATE' | 'HITA_ARCHIVED_DIRECT_OWNER_EXCEPTION' | 'OWNER_ACCEPTED_ARCHIVED_INAX_BASELINE' | 'DPG_VOUCHER_FROM_STORED_EVIDENCE'
/** Owner decision that lets rows of ONE pinned CSV be planned although their source time is older than the 24 h gate and their Hita Offer date has passed (no re-crawl, no price tracking: the pinned prices are DPG's own).
 * Never a blanket switch: the CSV sha256 and the exact id set are pinned (set equality, both directions), vouchers must be empty, timestamps are never touched. Rows outside a pin still stop when stale/expired. */
export type FreshnessException = { approved_by: 'Owner'; approval_ref: string; rule_ref: string; csv_sha256: string; approved_ids: number[]; approved_basis: 'ARCHIVED_EVIDENCE_DIRECT_REFRESH_EXCEPTION' }
export type Plan = {
  csvSha256: string; candidateSha: string; planSha: string; batchSize: number; brandId: number; brand: BrandKey; state: PlanState
  /** candidate:csv:plan — an IDENTITY string for the manifest, never an authorisation: only the Owner's GO authorises execution. */
  releaseBinding: string
  summary: Record<string, unknown>; stopReasons: string[]; rows: PlanRow[]; batches: PlanRow[][]
  /** HITA_REVIEW = direct Hita EXACT crawl row (default). OWNER_ACCEPTED_CANDIDATE = Owner-approved single historical price (never labelled as direct Hita-verified). */
  source?: PlanSource
  approvalRef?: string
}

export const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number.isSafeInteger(Number(v)) ? Number(v) : NaN)
export const canonOf = (r: DbRow): Canon => ({ status: (r.canonical_price_status ?? null) as CanonStatus | null, regular: num(r.regular_price_vnd), promo: num(r.promotional_price_vnd), voucher: num(r.online_voucher_amount_vnd) })
export const same = (a: Canon, b: Canon) => a.status === b.status && a.regular === b.regular && a.promo === b.promo && a.voucher === b.voucher
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
export const SKU_SAFE = /^[\x21-\x7e]{1,100}$/                // printable ASCII, no space: keeps generated SQL literal-safe
export const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

// Hita class -> stored status. Unverified outcomes (NOT_CRAWLED / BLOCKED / UNKNOWN) are NEVER written: they stay NULL
// (price hidden, "cần liên hệ") and can never become CONTACT_VERIFIED (Owner decision #466).
const STATUS_OF: Record<string, CanonStatus | undefined> = {
  PRICE_VERIFIED: 'PRICE_VERIFIED', CONTACT_VERIFIED: 'CONTACT_VERIFIED', NOT_FOUND_CANDIDATE_DELETE: 'NOT_FOUND',
  DISCONTINUED_REVIEW: 'DISCONTINUED', AMBIGUOUS_UNVERIFIED: 'UNRESOLVED',
}

export type PlanInput = {
  csvText: string; expectedCsvSha256: string; candidateSha: string; inventory: InvRow[]; db: DbRow[]; dbSizeBytes: number
  now: Date; maxAgeHours?: number; batchSize?: number
  /** The ONE brand this plan is pinned to (default toto). Every planned row must carry its immutable id, and every SQL batch re-checks id + slug. */
  brand?: BrandKey
  /** The ONE approved is_active state of this plan (default active). Rows of the other state are skipped, never touched; is_active is never changed. */
  state?: PlanState
  /** Owner exception for a pinned archived-direct CSV (see FreshnessException). Without it a stale (> maxAgeHours) or expired planned row STOPS the plan. */
  freshnessException?: FreshnessException | null
}

export function buildPlan(input: PlanInput): Plan {
  const stop: string[] = []
  const csvSha256 = sha256(input.csvText)
  if (!/^[0-9a-f]{64}$/.test(input.expectedCsvSha256)) stop.push('EXPECTED_CSV_SHA256_MISSING_OR_MALFORMED')
  else if (csvSha256 !== input.expectedCsvSha256) stop.push(`CSV_SHA256_MISMATCH expected=${input.expectedCsvSha256} actual=${csvSha256}`)
  if (!/^[0-9a-f]{40}$/.test(input.candidateSha)) stop.push('CANDIDATE_SHA_MISSING_OR_MALFORMED')
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) stop.push('BATCH_SIZE_OUT_OF_RANGE_1_500')

  const inv = new Map(input.inventory.map(r => [r.id, r]))
  const result = validate(input.csvText, { now: input.now, maxAgeHours: input.maxAgeHours ?? 24, inventory: inv })
  const gate = summarise(result)
  if (result.fileIssues.length) stop.push(...result.fileIssues.map(f => `CSV_FILE_ISSUE:${f}`))
  const failRows = new Set(result.issues.filter(i => i.severity === 'FAIL').map(i => i.line))
  if (failRows.size) stop.push(`QUALITY_GATE_FAIL rows=${failRows.size}`)

  const db = new Map(input.db.map(r => [r.id, r]))
  const rows: PlanRow[] = []
  const brand: BrandKey = input.brand ?? 'toto', state: PlanState = input.state ?? 'active'
  if (!(brand in BRANDS)) stop.push('BRAND_NOT_APPROVED')
  if (state !== 'active' && state !== 'inactive') stop.push('STATE_INVALID')
  const brandId = BRANDS[brand]?.id ?? 0, wantActive = state === 'active'
  const counts = { in_csv: result.data?.length ?? 0, skipped_other_state: 0, skipped_unverified: 0, unchanged: 0, to_change: 0, blocked_identity: 0, skipped_newer_db_edit: 0 }
  const newerEdits: number[] = []
  const byStatus: Record<string, number> = {}
  const warnLines = new Set(result.issues.filter(i => i.severity === 'WARN').map(i => i.line))
  // Freshness is fail-closed: a planned row older than the gate, or whose Offer validity has passed, stops the plan unless the Owner exception pins it.
  const staleLines = new Set(result.issues.filter(i => i.code === 'CHECKED_STALE').map(i => i.line))
  const expiredLines = new Set(result.issues.filter(i => i.code === 'VALID_UNTIL_EXPIRED').map(i => i.line))
  const exc = input.freshnessException ?? null
  const excIds = new Set<number>()
  if (exc) {
    if (exc.approved_by !== 'Owner' || !exc.approval_ref || !exc.rule_ref || exc.approved_basis !== 'ARCHIVED_EVIDENCE_DIRECT_REFRESH_EXCEPTION') stop.push('FRESHNESS_EXCEPTION_INCOMPLETE')
    if (exc.csv_sha256 !== csvSha256) stop.push('FRESHNESS_EXCEPTION_FOR_A_DIFFERENT_CSV')
    if (!Array.isArray(exc.approved_ids) || exc.approved_ids.some(i => !Number.isSafeInteger(i)) || new Set(exc.approved_ids).size !== exc.approved_ids.length) stop.push('FRESHNESS_EXCEPTION_IDS_INVALID')
    else {
      exc.approved_ids.forEach(i => excIds.add(i))
      const inCsv = new Set((result.data ?? []).map(r => Number(r.dpg_id)))
      if (inCsv.size !== excIds.size || [...inCsv].some(i => !excIds.has(i))) stop.push('FRESHNESS_EXCEPTION_SCOPE_MISMATCH')   // exact set, both directions
    }
  }
  if (!result.fileIssues.length) result.data.forEach((r, idx) => {
    const klass = result.klass[idx]
    const status = STATUS_OF[klass]
    const id = Number(r.dpg_id), active = r.is_active === 'true'
    if (active !== wantActive) { counts.skipped_other_state++; return }
    if (!status) { counts.skipped_unverified++; return }
    const cur = db.get(id)
    // identity: id + SKU + category + is_active must agree across CSV, inventory and the live row. Any miss stops the whole plan.
    if (!cur || cur.sku !== r.sku || cur.category_id !== SANITARY_CATEGORY_ID || cur.brand_id !== brandId || cur.is_active !== active || !SKU_SAFE.test(r.sku) || r.category !== 'thiet-bi-ve-sinh'
      || !Number.isSafeInteger(cur.version) || (cur.version as number) < 1) {
      counts.blocked_identity++; stop.push(`IDENTITY_MISMATCH id=${r.dpg_id} sku=${r.sku.slice(0, 30)}`); return
    }
    const line = idx + 2, covered = !!exc && excIds.has(id) && !stop.some(s => s.startsWith('FRESHNESS_EXCEPTION_'))
    // Freshness guards protect MONEY: they apply to rows that would store a price. Status-only rows (CONTACT/DISCONTINUED/UNRESOLVED/NOT_FOUND) carry no price and keep the warn-only behaviour.
    if (status === 'PRICE_VERIFIED') {
      if (expiredLines.has(line) && !covered) { stop.push(`PRICE_OFFER_EXPIRED id=${id}`); return }  // an Owner-pinned row is DPG's official price: the Hita Offer date never blocks it (Owner 24/11)
      if (staleLines.has(line) && !covered) { stop.push(`CHECKED_STALE_NOT_APPROVED id=${id}`); return }
      if (covered && num(r.online_voucher_amount_vnd) !== null) { stop.push(`EXCEPTION_ROW_HAS_VOUCHER id=${id}`); return }   // voucher policy: held, never imported here
    }
    const after: Canon = status === 'PRICE_VERIFIED'
      ? { status, regular: num(r.regular_price_vnd), promo: num(r.promotional_price_vnd), voucher: num(r.online_voucher_amount_vnd) }
      : { status, regular: null, promo: null, voucher: null }
    if (!ISO.test(r.source_checked_at_utc)) { stop.push(`CHECKED_AT_INVALID id=${id}`); return }
    const before = canonOf(cur)
    ;[...Object.values(before), ...Object.values(after)].forEach(v => { if (typeof v === 'number' && !Number.isSafeInteger(v)) stop.push(`NON_INTEGER_VALUE id=${id}`) })
    byStatus[status] = (byStatus[status] ?? 0) + 1
    if (same(before, after)) { counts.unchanged++; return }
    // Never overwrite a newer value: a row whose canonical state was set AFTER this crawl (e.g. an Admin edit) is skipped and listed.
    const beforeCheckedAt = cur.canonical_price_checked_at ? new Date(cur.canonical_price_checked_at).toISOString() : null
    if (beforeCheckedAt && Date.parse(beforeCheckedAt) > Date.parse(r.source_checked_at_utc)) { counts.skipped_newer_db_edit++; newerEdits.push(id); return }
    counts.to_change++
    rows.push({ id, sku: r.sku, is_active: active, klass, before, after, beforeCheckedAt, version: cur.version as number, checkedAt: r.source_checked_at_utc, sourceUrl: r.hita_url,
      ...(covered ? { provenance: { basis: 'HITA_ARCHIVED_DIRECT_OWNER_EXCEPTION', not_reconfirmed: true, source_checked_at_utc: r.source_checked_at_utc, approval_ref: exc!.approval_ref, rule_ref: exc!.rule_ref } } : {}) })
  })
  rows.sort((a, b) => a.id - b.id)
  const dup = rows.length - new Set(rows.map(r => r.id)).size
  if (dup) stop.push(`DUPLICATE_IDS_IN_PLAN count=${dup}`)

  // Size guard: stop BEFORE any write when the projected size would leave less than the safety margin under the 350 MiB trigger.
  const estGrowth = rows.length * BYTES_PER_CHANGED_ROW
  const projected = input.dbSizeBytes + estGrowth
  if (projected > DB_CEILING_BYTES - SAFETY_MARGIN_BYTES) stop.push(`DB_HEADROOM_INSUFFICIENT projected=${projected} limit=${DB_CEILING_BYTES - SAFETY_MARGIN_BYTES}`)

  const batches: PlanRow[][] = []
  for (let i = 0; i < rows.length; i += batchSize) batches.push(rows.slice(i, i + batchSize))
  const planSha = sha256(JSON.stringify({ csvSha256, candidateSha: input.candidateSha, batchSize, brand, brandId, state, target: PRODUCTION_TARGET, ...(exc ? { freshnessException: [exc.approval_ref, exc.rule_ref, exc.csv_sha256, [...excIds].sort((a, b) => a - b)] } : {}), rows: rows.map(r => [r.id, r.sku, r.version, r.before, r.beforeCheckedAt, r.after, r.checkedAt]) }))
  const summary = {
    ...counts, newer_db_edit_ids: newerEdits.slice(0, 50), brand, brand_id: brandId, state, rows_by_status: byStatus, batches: batches.length, batch_size: batchSize, quality_gate: { rows_with_fail: failRows.size, rows_with_warn: warnLines.size, warn_by_code: gate.warn_by_code, fail_by_code: gate.fail_by_code },
    db_size_bytes: input.dbSizeBytes, est_growth_bytes: estGrowth, projected_db_bytes: projected, headroom_after_bytes: DB_CEILING_BYTES - projected,
  }
  return { csvSha256, candidateSha: input.candidateSha, planSha, batchSize, brandId, brand, state, releaseBinding: `${input.candidateSha}:${csvSha256}:${planSha}`, summary, stopReasons: [...new Set(stop)], rows, batches,
    ...(exc ? { source: 'HITA_ARCHIVED_DIRECT_OWNER_EXCEPTION' as const, approvalRef: exc.approval_ref } : {}) }
}

const lit = (v: number | null) => (v === null ? 'null::bigint' : String(v))
const stat = (s: CanonStatus | null) => (s === null ? 'null::text' : `'${s}'::text`)
const batchBytes = (n: number) => n * BYTES_PER_CHANGED_ROW

const ts = (v: string | null) => (v === null ? 'null::timestamptz' : `'${v}'::timestamptz`)
function batchSql(plan: Plan, idx: number, direction: 'apply' | 'rollback'): string {
  const rows = plan.batches[idx]
  const n = rows.length
  // apply:    basis = snapshot state (values, checked-at, version v)   -> target = CSV state,  version v+1
  // rollback: basis = applied state (values, CSV checked-at, v+1)       -> target = exact prior state (incl. checked-at), version v+2
  // A row edited by anyone in between no longer matches its basis, so the row count check aborts the WHOLE batch: nothing stale is written.
  const values = rows.map(r => {
    const applying = direction === 'apply'
    const from = applying ? r.before : r.after, to = applying ? r.after : r.before
    const fromChecked = applying ? r.beforeCheckedAt : r.checkedAt, toChecked = applying ? r.checkedAt : r.beforeCheckedAt
    const fromVersion = applying ? r.version : r.version + 1
    return `(${r.id}, '${r.sku}', ${r.is_active}, ${fromVersion}, ${stat(from.status)}, ${lit(from.regular)}, ${lit(from.promo)}, ${lit(from.voucher)}, ${ts(fromChecked)}, ${stat(to.status)}, ${lit(to.regular)}, ${lit(to.promo)}, ${lit(to.voucher)}, ${ts(toChecked)})`
  }).join(',\n    ')
  const T = PRODUCTION_TARGET
  return `-- #470 import batch ${idx + 1}/${plan.batches.length} (${direction}) — plan ${plan.planSha}
-- DRAFT. Price basis: ${plan.source ?? 'HITA_REVIEW'}${plan.approvalRef ? ` (approval ${plan.approvalRef})` : ''}. Scope: brand ${plan.brand} (id ${plan.brandId}) x is_active=${plan.state === 'active'} only. Runs ONLY after the Owner GO that names candidate ${plan.candidateSha}, CSV ${plan.csvSha256}, plan ${plan.planSha}.
-- The plan SHA below binds this file to that reviewed plan; it is NOT an authorisation by itself.
--   psql -v ON_ERROR_STOP=1 -v approved_sha=${plan.planSha} -f <this file>   (as the Production operator postgres)
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select set_config('dpg.price_release_go', :'approved_sha', true);
do $$
declare n integer;
begin
  if current_setting('dpg.price_release_go', true) is distinct from '${plan.planSha}' then raise exception 'PRICE_IMPORT_PLAN_SHA_MISMATCH'; end if;
  if not exists (select 1 from dpg_control.target_contract where project_name = '${T.projectName}' and region = '${T.region}'
      and environment = '${T.environment}' and production_data_allowed and production_writes_allowed and hard_database_ceiling_bytes = ${T.ceilingBytes}) then
    raise exception 'PRICE_IMPORT_TARGET_NOT_PRODUCTION_CONTRACT';
  end if;
  if not exists (select 1 from dpg_app.brands where id = ${plan.brandId} and slug = '${plan.brand}') then raise exception 'PRICE_IMPORT_BRAND_IDENTITY_CHANGED'; end if;
  if (select count(*) from information_schema.columns where table_schema = 'dpg_app' and table_name = 'products'
      and column_name in ('regular_price_vnd','promotional_price_vnd','online_voucher_amount_vnd','canonical_price_status','canonical_price_checked_at')) <> 5 then
    raise exception 'PRICE_IMPORT_SCHEMA_001_MISSING';
  end if;
  -- stop rule: this batch must still leave the safety margin under the 350 MiB trigger
  if pg_database_size(current_database()) + ${batchBytes(n)} > ${DB_CEILING_BYTES - SAFETY_MARGIN_BYTES} then raise exception 'PRICE_IMPORT_HEADROOM_STOP'; end if;
  update dpg_app.products p set
    canonical_price_status = v.to_status, regular_price_vnd = v.to_regular, promotional_price_vnd = v.to_promo,
    online_voucher_amount_vnd = v.to_voucher, canonical_price_checked_at = v.to_checked, version = p.version + 1
  from (values
    ${values}
  ) as v(id, sku, is_active, from_version, from_status, from_regular, from_promo, from_voucher, from_checked, to_status, to_regular, to_promo, to_voucher, to_checked)
  where p.id = v.id and p.sku = v.sku and p.category_id = ${SANITARY_CATEGORY_ID} and p.brand_id = ${plan.brandId}
    and p.is_active = ${plan.state === 'active'} and p.is_active = v.is_active   -- state is pinned for the whole plan; a concurrent activate/deactivate fails the basis
    and p.version = v.from_version
    and p.canonical_price_status is not distinct from v.from_status
    and p.regular_price_vnd is not distinct from v.from_regular
    and p.promotional_price_vnd is not distinct from v.from_promo
    and p.online_voucher_amount_vnd is not distinct from v.from_voucher
    and p.canonical_price_checked_at is not distinct from v.from_checked;
  get diagnostics n = row_count;
  if n <> ${n} then raise exception 'PRICE_IMPORT_ROWCOUNT_MISMATCH batch=${idx + 1} expected=${n} got=%', n; end if;
end
$$;
commit;
`
}

export const applySql = (plan: Plan, idx: number) => batchSql(plan, idx, 'apply')
export const rollbackSql = (plan: Plan, idx: number) => batchSql(plan, idx, 'rollback')

/** Ledger = the full before/after of every planned row; the offline rollback source. One JSON object per line. */
export const ledgerJsonl = (plan: Plan) => plan.batches.flatMap((b, i) => b.map(r => JSON.stringify({ batch: i + 1, id: r.id, sku: r.sku, brand: plan.brand, brand_id: plan.brandId, state: plan.state, klass: r.klass, version_before: r.version,
  before: r.before, before_checked_at: r.beforeCheckedAt, after: r.after, checked_at: r.checkedAt, source_url: r.sourceUrl,
  price_basis: plan.source ?? 'HITA_REVIEW', ...(r.provenance ? { provenance: r.provenance } : {}) }))).join('\n') + '\n'

/** Identity check only (does the text quoted in the Owner GO match this exact plan?). It authorises nothing: the GO itself does. */
export function releaseBindingMatches(plan: Plan, quoted: string | undefined) { return !!quoted && plan.stopReasons.length === 0 && quoted === plan.releaseBinding }

/** Read-only query that produces the DbRow snapshot (run on Production with the read-only role). */
/** Read-only snapshot for ONE brand (all states; the plan filters one state). Replace :brand_id with BRANDS[brand].id. */
export const SNAPSHOT_SQL = `select id, sku, category_id, brand_id, is_active, version, canonical_price_status, regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd, canonical_price_checked_at
  from dpg_app.products where category_id = ${SANITARY_CATEGORY_ID} and brand_id = :brand_id order by id;
select pg_database_size(current_database()) as db_size_bytes;`
export const SNAPSHOT_SQL_PRE_001 = `select id, sku, category_id, brand_id, is_active, version from dpg_app.products where category_id = ${SANITARY_CATEGORY_ID} and brand_id = :brand_id order by id;`
