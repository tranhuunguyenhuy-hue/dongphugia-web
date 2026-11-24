// @vitest-environment node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applySql, buildPlan, ledgerJsonl, rollbackSql, sha256, type DbRow, type FreshnessException, type Plan } from './prod-import-core.mts'
import { buildCandidatePlan, type CandidateApproval } from './prod-import-candidates.mts'
import { buildBaselinePlan, type BaselineDecision } from './prod-import-baseline.mts'
import { buildVoucherPlan, type VoucherApproval } from './prod-import-voucher.mts'
import { parseCsv } from './quality-gate-core.mts'

// #470 (TL 7128033322): offline acceptance of the Codex package #485 (docs/ops/hita-448/owner-accepted-candidates) through the REAL planners.
// Synthetic DB snapshot (version 1, empty canonical columns) built from the package's own scope index; nothing here reads or writes a database.
const dir = path.resolve(__dirname, '../../docs/ops/hita-448/owner-accepted-candidates')
const read = (f: string) => readFileSync(path.join(dir, f), 'utf8')
const json = <T,>(f: string) => JSON.parse(read(f)) as T
const COHORTS = [['toto-active', 'toto', 'active', 1, 1543, 67], ['toto-inactive', 'toto', 'inactive', 1, 926, 393], ['inax-active', 'inax', 'active', 2, 305, 467], ['inax-inactive', 'inax', 'inactive', 2, 8, 392]] as const
const NOW = new Date('2026-11-25T01:00:00Z'), SHA = 'd'.repeat(40), DB_SIZE = 293_328_563
const scope = parseCsv(read('scope-index.csv')).slice(1).map(c => ({ brand: c[0], active: c[1] === 'true', id: Number(c[3]), sku: c[4] }))
const snapshot = (brandId: number, active: boolean, over: Record<number, Partial<DbRow>> = {}): DbRow[] => scope.filter(r => (r.brand === 'TOTO' ? 1 : 2) === brandId && r.active === active)
  .map(r => ({ id: r.id, sku: r.sku, category_id: 1, brand_id: brandId, is_active: r.active, version: 1, canonical_price_status: null, regular_price_vnd: null, promotional_price_vnd: null, online_voucher_amount_vnd: null, canonical_price_checked_at: null, ...over[r.id] }))
const inventory = scope.map(r => ({ id: r.id, sku: r.sku, is_active: r.active }))
const direct = (cohort: string, brand: 'toto' | 'inax', state: 'active' | 'inactive', brandId: number, over: Partial<{ csv: string; exc: FreshnessException | null; now: Date; db: DbRow[] }> = {}): Plan => {
  const csv = over.csv ?? read(`${cohort}/archived-direct.csv`), exc = over.exc === undefined ? json<FreshnessException>(`${cohort}/archived-direct-approval.json`) : over.exc
  return buildPlan({ csvText: csv, expectedCsvSha256: sha256(csv), candidateSha: SHA, inventory, db: over.db ?? snapshot(brandId, state === 'active'), dbSizeBytes: DB_SIZE, now: over.now ?? NOW, brand, state, freshnessException: exc })
}
const cand = (cohort: string, brand: 'toto' | 'inax', state: 'active' | 'inactive', brandId: number, over: Partial<{ csv: string; approval: CandidateApproval | null; db: DbRow[] }> = {}): Plan => {
  const csv = over.csv ?? read(`${cohort}/candidate.csv`)
  return buildCandidatePlan({ csvText: csv, expectedCsvSha256: sha256(csv), approval: over.approval === undefined ? json<CandidateApproval>(`${cohort}/owner-approval.json`) : over.approval, candidateSha: SHA, db: over.db ?? snapshot(brandId, state === 'active'), dbSizeBytes: DB_SIZE, brand, state, now: NOW })
}
const baseline = (over: Partial<{ csv: string; decision: BaselineDecision | null; db: DbRow[]; now: Date }> = {}): Plan => {
  const csv = over.csv ?? read('inax-active/inax-baseline-hold.csv')
  return buildBaselinePlan({ csvText: csv, expectedCsvSha256: sha256(csv), decision: over.decision === undefined ? json<BaselineDecision>('inax-active/inax-baseline-owner-decision.json') : over.decision, candidateSha: SHA, db: over.db ?? snapshot(2, true), dbSizeBytes: DB_SIZE, now: over.now ?? NOW })
}
const tamper = (csv: string, id: number, col: string, value: string) => {
  const table = parseCsv(csv), h = table[0].map(x => x.trim()), ci = h.indexOf(col), ii = h.indexOf('dpg_id'); const row = table.find((r, i) => i > 0 && r[ii] === String(id))!
  row[ci] = value
  const q = (v: string) => `"${v.replaceAll('"', '""')}"`; return table.map(r => r.map(q).join(',')).join('\r\n') + '\r\n'
}

describe('package #485 through the real planners — preserves the 4.101 PASS', () => {
  it.each(COHORTS)('%s: archived-direct (Owner freshness exception) plans exactly the pinned ids, stale source kept as is, voucher NULL', (cohort, brand, state, brandId, directRows) => {
    const p = direct(cohort, brand, state, brandId)
    expect(p.stopReasons).toEqual([]); expect(p.rows).toHaveLength(directRows); expect(p.source).toBe('HITA_ARCHIVED_DIRECT_OWNER_EXCEPTION')
    expect(p.rows.every(r => r.after.voucher === null && r.after.status === 'PRICE_VERIFIED' && r.provenance?.not_reconfirmed === true && r.checkedAt.startsWith('2026-11-2'))).toBe(true)
    expect(JSON.parse(ledgerJsonl(p).split('\n')[0])).toMatchObject({ price_basis: 'HITA_ARCHIVED_DIRECT_OWNER_EXCEPTION', provenance: { not_reconfirmed: true } })
  })
  it.each(COHORTS)('%s: Owner-accepted candidates plan exactly the approved ids, regular price only', (cohort, brand, state, brandId, _d, candRows) => {
    const p = cand(cohort, brand, state, brandId)
    expect(p.stopReasons).toEqual([]); expect(p.rows).toHaveLength(candRows)
    expect(p.rows.every(r => r.after.promo === null && r.after.voucher === null && r.provenance?.not_direct_hita_verified === true)).toBe(true)
  })
  it('totals: 2.782 archived-direct + 1.319 candidates = 4.101 (2.382 active / 1.719 inactive), disjoint per SKU', () => {
    const ids = new Map<number, string>(); let active = 0, inactive = 0
    for (const [cohort, brand, state, brandId] of COHORTS) for (const [lane, p] of [['direct', direct(cohort, brand, state, brandId)], ['cand', cand(cohort, brand, state, brandId)]] as const) {
      for (const r of p.rows) { expect(ids.has(r.id), `id ${r.id} in ${lane} and ${ids.get(r.id)}`).toBe(false); ids.set(r.id, lane); if (r.is_active) active++; else inactive++ }
    }
    expect(ids.size).toBe(4101); expect(active).toBe(2382); expect(inactive).toBe(1719)
  })
})

describe('547 INAX active baseline lane (Owner decision inax-baseline-owner-decision.json)', () => {
  it('plans exactly the 547 pinned ids: 545 regular+promotion, 2 regular-only, voucher NULL, source time kept, provenance in the ledger', () => {
    const p = baseline()
    expect(p.stopReasons).toEqual([]); expect(p.rows).toHaveLength(547)
    expect(p.summary).toMatchObject({ regular_and_promo: 545, regular_only: 2, price_basis: 'OWNER_ACCEPTED_ARCHIVED_INAX_BASELINE' })
    expect(p.rows.every(r => r.after.voucher === null && r.after.status === 'PRICE_VERIFIED' && r.checkedAt.startsWith('2026-11-24T0'))).toBe(true)
    expect(p.rows.filter(r => r.after.promo === null).map(r => r.id).sort((a, b) => a - b)).toEqual([559, 7679])
    expect(JSON.parse(ledgerJsonl(p).split('\n')[0])).toMatchObject({ price_basis: 'OWNER_ACCEPTED_ARCHIVED_INAX_BASELINE', provenance: { not_reconfirmed: true, approval_ref: expect.stringContaining('issuecomment') } })
  })
  it('totals: 4.101 + 547 = 4.648 (2.929 active / 1.719 inactive), 1.634 regular-only + 3.014 regular+promotion, all voucher NULL, all disjoint', () => {
    const plans = COHORTS.flatMap(([cohort, brand, state, brandId]) => [direct(cohort, brand, state, brandId), cand(cohort, brand, state, brandId)]).concat(baseline())
    const rows = plans.flatMap(p => p.rows); expect(new Set(rows.map(r => r.id)).size).toBe(4648)
    expect(rows.filter(r => r.is_active)).toHaveLength(2929); expect(rows.filter(r => !r.is_active)).toHaveLength(1719)
    expect(rows.filter(r => r.after.promo === null)).toHaveLength(1634); expect(rows.filter(r => r.after.promo !== null)).toHaveLength(3014); expect(rows.every(r => r.after.voucher === null)).toBe(true)
  })
  it('fails closed: tampered CSV / wrong decision / missing or extra id / wrong pin', () => {
    const csv = read('inax-active/inax-baseline-hold.csv'), dec = json<BaselineDecision>('inax-active/inax-baseline-owner-decision.json')
    expect(baseline({ decision: null }).stopReasons).toContain('OWNER_DECISION_MISSING')
    expect(baseline({ csv: tamper(csv, 248, 'regular_price_vnd', '1') }).stopReasons.join()).toMatch(/OWNER_DECISION_FOR_A_DIFFERENT_CSV|BASELINE_PROPOSAL_MISMATCH/)
    expect(baseline({ decision: { ...dec, review_csv_sha256: 'f'.repeat(64) } }).stopReasons).toContain('OWNER_DECISION_FOR_A_DIFFERENT_CSV')
    expect(baseline({ decision: { ...dec, scope_ids: dec.scope_ids.slice(1) } }).stopReasons).toContain('OWNER_DECISION_SCOPE_MISMATCH')
    expect(baseline({ decision: { ...dec, scope_ids: [...dec.scope_ids, 999999] } }).stopReasons).toContain('OWNER_DECISION_SCOPE_MISMATCH')
    expect(baseline({ decision: { ...dec, approved_by: 'Codex' as 'Owner' } }).stopReasons).toContain('OWNER_DECISION_INCOMPLETE')
  })
  it('a CSV that was altered AND re-pinned still stops on the row rules (promotion silently dropped, price changed, voucher added, label changed)', () => {
    const csv = read('inax-active/inax-baseline-hold.csv'), dec = json<BaselineDecision>('inax-active/inax-baseline-owner-decision.json')
    const run = (c: string) => baseline({ csv: c, decision: { ...dec, review_csv_sha256: sha256(c) } }).stopReasons.join()
    expect(run(tamper(csv, 248, 'proposed_promotional_price_vnd', ''))).toContain('BASELINE_PROMO_DROPPED_WITHOUT_REASON')
    expect(run(tamper(csv, 248, 'proposed_regular_price_vnd', '26660001'))).toContain('BASELINE_PROPOSAL_MISMATCH')
    expect(run(tamper(csv, 248, 'proposed_online_voucher_amount_vnd', '267000'))).toContain('BASELINE_PROPOSAL_MISMATCH')
    expect(run(tamper(csv, 248, 'review_status', 'FRESH_CRAWL_PENDING_OWNER_REVIEW'))).toContain('BASELINE_EVIDENCE_LABEL_MISMATCH')
    expect(run(tamper(csv, 248, 'direct_freshness', 'RECONFIRMED'))).toContain('BASELINE_EVIDENCE_LABEL_MISMATCH')
    expect(run(tamper(csv, 248, 'hita_exact_sku', 'AC-4005VN'))).toContain('BASELINE_EXACT_SKU_OR_URL_OR_CURRENCY_INVALID')
    expect(run(tamper(csv, 248, 'currency', 'USD'))).toContain('BASELINE_EXACT_SKU_OR_URL_OR_CURRENCY_INVALID')
    expect(run(tamper(csv, 248, 'brand', 'TOTO'))).toContain('IDENTITY_MISMATCH')
  })
  it('identity: wrong brand / state / category / sku / unknown id in the live snapshot stops the plan', () => {
    const base = snapshot(2, true)
    for (const patch of [{ brand_id: 1 }, { is_active: false }, { category_id: 5 }, { sku: 'OTHER' }]) expect(baseline({ db: base.map(r => (r.id === 248 ? { ...r, ...patch } : r)) }).stopReasons.join()).toContain('IDENTITY_MISMATCH id=248')
    expect(baseline({ db: base.filter(r => r.id !== 248) }).stopReasons.join()).toContain('IDENTITY_MISMATCH id=248')
  })
  it('the Hita Offer date does not block the pinned rows (DPG official prices); the lane is INAX-active only; never overwrites a stored price or a newer Admin edit', () => {
    const later = baseline({ now: new Date('2027-03-01T00:00:00Z') }); expect(later.stopReasons).toEqual([]); expect(later.rows).toHaveLength(547)
    expect(buildBaselinePlan({ csvText: read('inax-active/inax-baseline-hold.csv'), expectedCsvSha256: sha256(read('inax-active/inax-baseline-hold.csv')), decision: json('inax-active/inax-baseline-owner-decision.json'), candidateSha: SHA, db: snapshot(2, true), dbSizeBytes: DB_SIZE, now: NOW, brand: 'toto', state: 'active' }).stopReasons).toContain('BASELINE_LANE_IS_INAX_ACTIVE_ONLY')
    const stored = snapshot(2, true, { 248: { canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: 9, canonical_price_checked_at: '2026-11-24T09:00:00Z' }, 249: { canonical_price_checked_at: '2026-11-24T12:00:00Z' } })
    const p = baseline({ db: stored }); expect(p.stopReasons).toEqual([]); expect(p.rows.map(r => r.id)).not.toContain(248); expect(p.rows.map(r => r.id)).not.toContain(249); expect(p.rows).toHaveLength(545)
  })
  it('apply/rollback SQL: pinned brand + state + version basis; rollback restores the exact prior (empty) state', () => {
    const p = baseline(); const apply = applySql(p, 0), roll = rollbackSql(p, 0)
    expect(apply).toContain('Price basis: OWNER_ACCEPTED_ARCHIVED_INAX_BASELINE'); expect(apply).toContain('p.brand_id = 2'); expect(apply).toContain('p.is_active = true')
    expect(roll).toContain('null::text'); expect(roll).toContain('PRICE_IMPORT_ROWCOUNT_MISMATCH')
  })
})

describe('freshness is fail-closed: no blanket disable', () => {
  const [cohort, brand, state, brandId] = COHORTS[0]
  it('the same stale CSV WITHOUT the Owner exception stops (CHECKED_STALE_NOT_APPROVED)', () => {
    const p = direct(cohort, brand, state, brandId, { exc: null }); expect(p.stopReasons.some(s => s.startsWith('CHECKED_STALE_NOT_APPROVED'))).toBe(true)
  })
  it('exception for another CSV / altered id set / extra or missing id / wrong approver / wrong basis => stops', () => {
    const exc = json<FreshnessException>(`${cohort}/archived-direct-approval.json`), csv = read(`${cohort}/archived-direct.csv`)
    expect(direct(cohort, brand, state, brandId, { exc: { ...exc, csv_sha256: 'e'.repeat(64) } }).stopReasons).toContain('FRESHNESS_EXCEPTION_FOR_A_DIFFERENT_CSV')
    expect(direct(cohort, brand, state, brandId, { exc: { ...exc, approved_ids: exc.approved_ids.slice(1) } }).stopReasons).toContain('FRESHNESS_EXCEPTION_SCOPE_MISMATCH')
    expect(direct(cohort, brand, state, brandId, { exc: { ...exc, approved_ids: [...exc.approved_ids, 5] } }).stopReasons).toContain('FRESHNESS_EXCEPTION_SCOPE_MISMATCH')
    expect(direct(cohort, brand, state, brandId, { exc: { ...exc, approved_by: 'Codex' as 'Owner' } }).stopReasons).toContain('FRESHNESS_EXCEPTION_INCOMPLETE')
    expect(direct(cohort, brand, state, brandId, { exc: { ...exc, approved_basis: 'ANY' as never } }).stopReasons).toContain('FRESHNESS_EXCEPTION_INCOMPLETE')
    // a tampered price in the pinned CSV: the Owner pin no longer matches => stops (re-pinning the CSV by hand is a different approval)
    const edited = tamper(csv, 207, 'regular_price_vnd', '1')
    expect(direct(cohort, brand, state, brandId, { csv: edited }).stopReasons).toContain('FRESHNESS_EXCEPTION_FOR_A_DIFFERENT_CSV')
  })
  it('an expired Offer does NOT block a pinned row, but still stops an UNPINNED stale/expired row; a voucher in an exception row stops', () => {
    const late = direct(cohort, brand, state, brandId, { now: new Date('2027-03-01T00:00:00Z') }); expect(late.stopReasons).toEqual([]); expect(late.rows).toHaveLength(1543)
    expect(direct(cohort, brand, state, brandId, { exc: null, now: new Date('2027-03-01T00:00:00Z') }).stopReasons.some(s => /^(PRICE_OFFER_EXPIRED|CHECKED_STALE_NOT_APPROVED)/.test(s))).toBe(true)
    const csv = tamper(tamper(read(`${cohort}/archived-direct.csv`), 207, 'online_voucher_amount_vnd', '1000'), 207, 'voucher_condition', 'Ưu đãi online')
    const exc = { ...json<FreshnessException>(`${cohort}/archived-direct-approval.json`), csv_sha256: sha256(csv) }
    expect(direct(cohort, brand, state, brandId, { csv, exc }).stopReasons.some(s => s.startsWith('EXCEPTION_ROW_HAS_VOUCHER'))).toBe(true)
  })
  it('cross-brand / cross-state use of an approved CSV stops on identity', () => {
    expect(direct(cohort, 'inax', 'active', 2).stopReasons.join()).toContain('IDENTITY_MISMATCH')
    const other = direct(cohort, 'toto', 'inactive', 1); expect(other.rows).toEqual([]); expect(other.summary.skipped_other_state).toBe(1543)   // wrong state plans nothing: no row of the other state is ever written
  })
})

describe('status lane (CONTACT / DISCONTINUED rows of import-handoff) — no price, planner-compatible, not an Owner-approved import', () => {
  const hand = path.resolve(__dirname, '../../docs/ops/hita-448/import-handoff')
  it.each([['toto-active', 'toto', 'active', 1, 332], ['toto-inactive', 'toto', 'inactive', 1, 935], ['inax-active', 'inax', 'active', 2, 16], ['inax-inactive', 'inax', 'inactive', 2, 1]] as const)('%s: %i status rows, never a price, stale source is only a warning', (cohort, brand, state, brandId, n) => {
    const csv = readFileSync(path.join(hand, cohort, 'status-review.csv'), 'utf8')
    const p = buildPlan({ csvText: csv, expectedCsvSha256: sha256(csv), candidateSha: SHA, inventory, db: snapshot(brandId, state === 'active'), dbSizeBytes: DB_SIZE, now: NOW, brand, state })
    expect(p.stopReasons).toEqual([]); expect(p.rows).toHaveLength(n)
    expect(p.rows.every(r => r.after.regular === null && r.after.promo === null && r.after.voucher === null && ['CONTACT_VERIFIED', 'DISCONTINUED'].includes(String(r.after.status)))).toBe(true)
  })
})

describe('voucher lane (Owner 24/11): DPG accepts the Hita exact-SKU voucher amount for pinned SKUs, after the price lanes', () => {
  const vdir = path.resolve(__dirname, '../../docs/ops/price-release-470/voucher-lane')
  const vcsv = readFileSync(path.join(vdir, 'voucher-approved.csv'), 'utf8'), vapproval = JSON.parse(readFileSync(path.join(vdir, 'voucher-approval.json'), 'utf8')) as VoucherApproval
  // DB state AFTER lanes A+B+C were applied (prices present, voucher NULL, check time = source time)
  const priced = (brandId: number, active: boolean): DbRow[] => {
    const after = new Map<number, { regular: number | null; promo: number | null; checked: string }>()
    for (const [cohort, brand, state, bid] of COHORTS) for (const p of [direct(cohort, brand, state, bid), cand(cohort, brand, state, bid)]) for (const r of p.rows) after.set(r.id, { regular: r.after.regular, promo: r.after.promo, checked: r.checkedAt })
    for (const r of baseline().rows) after.set(r.id, { regular: r.after.regular, promo: r.after.promo, checked: r.checkedAt })
    return snapshot(brandId, active).map(r => { const a = after.get(r.id); return a ? { ...r, canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: a.regular, promotional_price_vnd: a.promo, canonical_price_checked_at: a.checked } : r })
  }
  const vplan = (brand: 'toto' | 'inax', state: 'active' | 'inactive', brandId: number, over: Partial<{ csv: string; approval: VoucherApproval | null; db: DbRow[] }> = {}): Plan => {
    const csv = over.csv ?? vcsv
    return buildVoucherPlan({ csvText: csv, expectedCsvSha256: sha256(csv), approval: over.approval === undefined ? vapproval : over.approval, candidateSha: SHA, db: over.db ?? priced(brandId, state === 'active'), dbSizeBytes: DB_SIZE, brand, state })
  }
  it('the committed package matches the evidence: 1.101 approved (745 TOTO + 356 INAX); the 29 Owner-NULL TOTO and the 2 promotion-held INAX rows stay NULL', () => {
    expect(vapproval.approved_ids).toHaveLength(1101); expect(vapproval.hold_null_ids).toHaveLength(31); expect(vapproval.csv_sha256).toBe(sha256(vcsv))
    expect(vapproval.hold_null_ids).toEqual(expect.arrayContaining([559, 7679])); expect(vapproval.approved_ids.some(i => vapproval.hold_null_ids.includes(i))).toBe(false)
    expect(vcsv).not.toMatch(/Ưu đãi|online|HITA_ONLY/i)                                                   // no advertising text is copied
  })
  it('plans exactly the pinned vouchers per brand x state; the voucher is below the selling price; price, promotion and check time untouched', () => {
    let total = 0, toto = 0, inax = 0
    for (const [, brand, state, brandId] of COHORTS) {
      const p = vplan(brand, state, brandId); expect(p.stopReasons).toEqual([]); total += p.rows.length; if (brand === 'toto') toto += p.rows.length; else inax += p.rows.length
      for (const r of p.rows) { expect(r.after.voucher).toBeGreaterThan(0); expect(r.after.voucher!).toBeLessThan(r.before.promo ?? r.before.regular!); expect({ ...r.after, voucher: null }).toEqual(r.before); expect(r.checkedAt).toBe(r.beforeCheckedAt) }
    }
    expect([total, toto, inax]).toEqual([1101, 745, 356])
  })
  it('fails closed: no approval / different CSV / extra or missing id / held id / price lane not applied / amount >= selling / existing different voucher', () => {
    expect(vplan('toto', 'active', 1, { approval: null }).stopReasons).toContain('OWNER_APPROVAL_MISSING')
    expect(vplan('toto', 'active', 1, { approval: { ...vapproval, csv_sha256: 'a'.repeat(64) } }).stopReasons).toContain('OWNER_APPROVAL_FOR_A_DIFFERENT_CSV')
    expect(vplan('toto', 'active', 1, { approval: { ...vapproval, approved_ids: vapproval.approved_ids.slice(1) } }).stopReasons).toContain('OWNER_APPROVAL_SCOPE_MISMATCH')
    expect(vplan('toto', 'active', 1, { approval: { ...vapproval, hold_null_ids: [...vapproval.hold_null_ids, vapproval.approved_ids[0]] } }).stopReasons).toContain('VOUCHER_ID_IS_HELD_NULL')
    expect(vplan('toto', 'active', 1, { db: snapshot(1, true) }).stopReasons.join()).toContain('VOUCHER_ROW_NOT_PRICED_YET')
    const first = vapproval.approved_ids.find(i => scope.find(s => s.id === i)?.brand === 'TOTO' && scope.find(s => s.id === i)?.active)!
    const db = priced(1, true)
    expect(vplan('toto', 'active', 1, { db: db.map(r => (r.id === first ? { ...r, regular_price_vnd: 1, promotional_price_vnd: null } : r)) }).stopReasons.join()).toContain('VOUCHER_NOT_BELOW_SELLING_PRICE')
    const over = vplan('toto', 'active', 1, { db: db.map(r => (r.id === first ? { ...r, online_voucher_amount_vnd: 1 } : r)) }); expect(over.rows.map(r => r.id)).not.toContain(first); expect(over.summary.skipped_by_reason).toMatchObject({ VOUCHER_DOES_NOT_OVERRIDE_EXISTING: 1 })
    const edited = vcsv.replace(/^((?:[^\n]*\n)"[^"]*","[^"]*","[^"]*","[^"]*",)"\d+"/, '$1"1"'); expect(edited).not.toBe(vcsv); expect(vplan('toto', 'active', 1, { csv: edited }).stopReasons.join()).toMatch(/OWNER_APPROVAL_FOR_A_DIFFERENT_CSV/)
    expect(vplan('toto', 'active', 1, { db: db.map(r => (r.id === first ? { ...r, brand_id: 2 } : r)) }).stopReasons.join()).toContain('IDENTITY_MISMATCH')
  })
})

