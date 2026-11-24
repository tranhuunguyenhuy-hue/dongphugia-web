// @vitest-environment node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applySql, ledgerJsonl, rollbackSql, sha256, type DbRow } from './prod-import-core.mts'
import { buildCandidatePlan, CANDIDATE_COLUMNS, type CandidateApproval, type CandidateInput } from './prod-import-candidates.mts'

const NOW = new Date('2026-11-25T01:00:00Z'), SHA = 'c'.repeat(40)
const q = (v: string) => `"${v.replaceAll('"', '""')}"`
type Row = Record<string, string>
const base = (id: number, over: Row = {}): Row => ({
  brand: 'INAX', dpg_id: String(id), dpg_sku: `AC-${id}/BW1`, source_sku: `AC-${id}/BW1`, category: 'thiet-bi-ve-sinh', is_active: 'true', match_type: 'EXACT_SKU_INDIRECT_BRAND', confidence: 'MODERATE',
  review_status: 'HISTORICAL_PRICE_CANDIDATE', historical_regular_price_vnd: '5300000', historical_promotional_price_vnd: '', historical_online_voucher_amount_vnd: '', currency: 'VND',
  source_url: `https://hita.com.vn/p-${id}-${id}.html`, source_checked_at_utc: '2026-11-24T03:40:48.253Z', pdp_selling: '5.300.000đ', offer_price: '5300000.00', search_sku: `AC-${id}/BW1`,
  matched_hita_product_id: String(10000 + id), rule_version: 'OWNER_477_OFFLINE_7125968574', ...over })
const csv = (rows: Row[]) => '﻿' + [CANDIDATE_COLUMNS.map(q).join(','), ...rows.map(r => CANDIDATE_COLUMNS.map(c => q(r[c] ?? '')).join(','))].join('\r\n') + '\r\n'
const dbRow = (id: number, over: Partial<DbRow> = {}): DbRow => ({ id, sku: `AC-${id}/BW1`, category_id: 1, brand_id: 2, is_active: true, version: 1, canonical_price_status: null, regular_price_vnd: null, promotional_price_vnd: null, online_voucher_amount_vnd: null, canonical_price_checked_at: null, ...over })
const run = (rows: Row[], db: DbRow[], over: Partial<CandidateInput> = {}, ids = rows.map(r => Number(r.dpg_id))) => {
  const text = csv(rows)
  const approval: CandidateApproval = { approved_by: 'Owner', approval_ref: 'https://github.com/x/y/issues/443#issuecomment-1', rule_ref: '#443 comment 7127072994', candidate_csv_sha256: sha256(text), approved_ids: ids }
  return buildCandidatePlan({ csvText: text, expectedCsvSha256: sha256(text), approval, candidateSha: SHA, db, dbSizeBytes: 293_328_563, brand: 'inax', state: 'active', now: NOW, ...over })
}

describe('Owner-accepted historical candidates (#470 TL note 7127074691)', () => {
  it('imports an approved exact single price ONLY into regular_price_vnd, keeps the SOURCE timestamp and records provenance (not "direct Hita verified")', () => {
    const p = run([base(1), base(2)], [dbRow(1), dbRow(2)])
    expect(p.stopReasons).toEqual([])
    expect(p.source).toBe('OWNER_ACCEPTED_CANDIDATE'); expect(p.rows).toHaveLength(2)
    expect(p.rows[0].after).toEqual({ status: 'PRICE_VERIFIED', regular: 5300000, promo: null, voucher: null })
    expect(p.rows[0].checkedAt).toBe('2026-11-24T03:40:48.253Z')                 // the source time, never "now"
    const ledger = ledgerJsonl(p).trim().split('\n').map(l => JSON.parse(l))
    expect(ledger[0]).toMatchObject({ price_basis: 'OWNER_ACCEPTED_CANDIDATE', provenance: { not_direct_hita_verified: true, confidence: 'MODERATE', approval_ref: expect.stringContaining('issuecomment') } })
    expect(applySql(p, 0)).toContain('Price basis: OWNER_ACCEPTED_CANDIDATE'); expect(applySql(p, 0)).toContain("'2026-11-24T03:40:48.253Z'::timestamptz")
    expect(rollbackSql(p, 0)).toContain('null::text')                              // rollback restores the exact prior (empty) state
  })
  it('without an Owner approval document (or one for another CSV) nothing can be planned — a candidate file is never imported by itself', () => {
    const text = csv([base(1)])
    expect(buildCandidatePlan({ csvText: text, expectedCsvSha256: sha256(text), approval: null, candidateSha: SHA, db: [dbRow(1)], dbSizeBytes: 1, brand: 'inax', state: 'active', now: NOW }).stopReasons).toContain('OWNER_APPROVAL_MISSING')
    const other = run([base(1)], [dbRow(1)], {}); expect(other.rows).toHaveLength(1)
    const wrong = buildCandidatePlan({ ...(({ csvText: text, expectedCsvSha256: sha256(text), approval: { approved_by: 'Owner', approval_ref: 'r', rule_ref: 'r', candidate_csv_sha256: 'f'.repeat(64), approved_ids: [1] }, candidateSha: SHA, db: [dbRow(1)], dbSizeBytes: 1, brand: 'inax', state: 'active', now: NOW }) as CandidateInput) })
    expect(wrong.stopReasons).toContain('OWNER_APPROVAL_FOR_A_DIFFERENT_CSV')
  })
  it('only approved ids are planned; unapproved rows are counted, never written', () => {
    const p = run([base(1), base(2), base(3)], [dbRow(1), dbRow(2), dbRow(3)], {}, [2])
    expect(p.rows.map(r => r.id)).toEqual([2]); expect(p.summary.not_approved).toBe(2)
  })
  it.each([
    ['CANDIDATE_NOT_SINGLE_PRICE', { historical_promotional_price_vnd: '4000000' }],
    ['CANDIDATE_NOT_SINGLE_PRICE', { historical_online_voucher_amount_vnd: '100000' }],
    ['CANDIDATE_SKU_NOT_EXACT', { source_sku: 'AC-1' }],
    ['CANDIDATE_SKU_NOT_EXACT', { search_sku: 'AC-1/BW1 ' + 'x' }],
    ['CANDIDATE_PRICE_SOURCES_DISAGREE', { pdp_selling: '5.200.000đ' }],
    ['CANDIDATE_PRICE_SOURCES_DISAGREE', { offer_price: '5300001.00' }],
    ['CANDIDATE_MATCH_TOO_WEAK', { confidence: 'LOW' }],
    ['CANDIDATE_MATCH_TOO_WEAK', { match_type: 'ALIAS' }],
    ['CANDIDATE_REVIEW_STATUS', { review_status: 'FRESH_CRAWL_PENDING_OWNER_REVIEW' }],
    ['CANDIDATE_PRICE_INVALID', { historical_regular_price_vnd: '0' }],
    ['CANDIDATE_PRICE_INVALID', { currency: 'USD' }],
    ['CANDIDATE_STALE_REFRESH_BEFORE_USE', { source_checked_at_utc: '2026-11-10T00:00:00.000Z' }],
    ['CANDIDATE_CHECKED_AT_INVALID', { source_checked_at_utc: 'yesterday' }],
  ] as [string, Row][])('rejects the row with %s (%j) and writes nothing', (code, over) => {
    const p = run([base(1, over)], [dbRow(1)])
    expect(p.rows).toEqual([]); expect(p.summary.skipped_by_reason).toMatchObject({ [code]: 1 })
  })
  it('a Hita page id shared by two SKUs is a collision: neither is imported', () => {
    const p = run([base(1, { matched_hita_product_id: '777' }), base(2, { matched_hita_product_id: '777' }), base(3)], [dbRow(1), dbRow(2), dbRow(3)])
    expect(p.rows.map(r => r.id)).toEqual([3]); expect(p.summary.skipped_by_reason).toMatchObject({ CANDIDATE_HITA_ID_COLLISION: 2 })
  })
  it('never overrides a stored/direct-verified price, nor an Admin edit newer than the source; the stale 547-style baseline is not touched', () => {
    const direct = dbRow(1, { canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: 6000000, canonical_price_checked_at: '2026-11-24T05:00:00Z' })
    const edited = dbRow(2, { canonical_price_status: null, canonical_price_checked_at: '2026-11-24T04:00:00Z' })
    const p = run([base(1), base(2), base(3)], [direct, edited, dbRow(3)])
    expect(p.rows.map(r => r.id)).toEqual([3]); expect(p.summary.skipped_by_reason).toMatchObject({ CANDIDATE_DOES_NOT_OVERRIDE_STORED_PRICE: 1, NEWER_DB_EDIT: 1 })
  })
  it('identity: brand / state / sku / category must equal the live row, else the whole plan stops', () => {
    for (const bad of [dbRow(1, { brand_id: 1 }), dbRow(1, { is_active: false }), dbRow(1, { sku: 'OTHER' }), dbRow(1, { category_id: 5 })]) expect(run([base(1)], [bad]).stopReasons.join()).toContain('IDENTITY_MISMATCH')
    expect(run([base(1)], []).stopReasons.join()).toContain('IDENTITY_MISMATCH')
  })
  it('one plan = one brand x one state: other brand/state rows are ignored; checksum or headroom problems stop the plan', () => {
    const p = run([base(1), base(2, { brand: 'TOTO' }), base(3, { is_active: 'false' })], [dbRow(1), dbRow(2, { brand_id: 1 }), dbRow(3, { is_active: false })])
    expect(p.rows.map(r => r.id)).toEqual([1])
    expect(run([base(1)], [dbRow(1)], { expectedCsvSha256: '0'.repeat(64) }).stopReasons.join()).toContain('CSV_SHA256_MISMATCH')
    expect(run([base(1)], [dbRow(1)], { dbSizeBytes: 366_000_000 }).stopReasons.join()).toContain('DB_HEADROOM_INSUFFICIENT')
  })
  it('the plan SHA changes with the approved ids and the approval reference (the Owner decision is part of the identity)', () => {
    const rows = [base(1), base(2)], db = [dbRow(1), dbRow(2)]
    expect(run(rows, db, {}, [1, 2]).planSha).not.toBe(run(rows, db, {}, [1]).planSha)
  })
})

describe('real Codex package (docs/ops/hita-448/toto-inax-data-review) — offline readiness, no approval means no import', () => {
  const dir = path.resolve(__dirname, '../../docs/ops/hita-448/toto-inax-data-review')
  const read = (f: string) => readFileSync(path.join(dir, f), 'utf8')
  // planned = rows that pass EVERY rule when the Owner approves the whole scope. TOTO active: all 87 lack saved brand evidence (match_type/confidence empty) -> none is planned.
  it.each([['inax_inactive_historical_candidates.csv', 'inax', 'inactive', 2, 392], ['toto_inactive_historical_candidates.csv', 'toto', 'inactive', 1, 393], ['inax_historical_candidates.csv', 'inax', 'active', 2, 467], ['toto_historical_candidates.csv', 'toto', 'active', 1, 0]] as const)('%s parses (INAX and TOTO layouts) and, with an Owner approval of every id, plans only rows that satisfy ALL rules', (file, brand, state, brandId, planned) => {
    const text = read(file)
    // synthesise a DB snapshot from the file itself (read-only/offline) and approve every id of the scope
    const header = text.replace(/^﻿/, '').split(/\r?\n/)[0].split(',').map(h => h.replaceAll('"', ''))
    const rowsOf = text.replace(/^﻿/, '').split(/\r?\n/).slice(1).filter(Boolean).map(l => l.slice(1, -1).split('","')).map(c => Object.fromEntries(header.map((h, i) => [h, c[i]])))
    const scope = rowsOf.filter(r => r.brand.toLowerCase() === brand && (r.is_active === 'true') === (state === 'active'))
    const db: DbRow[] = scope.map(r => ({ id: Number(r.dpg_id), sku: r.dpg_sku ?? r.sku, category_id: 1, brand_id: brandId, is_active: state === 'active', version: 1, canonical_price_status: null, regular_price_vnd: null, promotional_price_vnd: null, online_voucher_amount_vnd: null, canonical_price_checked_at: null }))
    const latest = scope.map(r => r.source_checked_at_utc).sort().at(-1)!
    const withApproval = buildCandidatePlan({ csvText: text, expectedCsvSha256: sha256(text), approval: { approved_by: 'Owner', approval_ref: 'offline-readiness', rule_ref: '#443 comment 7127072994', candidate_csv_sha256: sha256(text), approved_ids: scope.map(r => Number(r.dpg_id)) },
      candidateSha: SHA, db, dbSizeBytes: 293_328_563, brand, state, now: new Date(Date.parse(latest) + 3600_000) })
    expect(withApproval.stopReasons).toEqual([])
    expect(withApproval.rows.length).toBe(planned)
    expect(withApproval.rows.every(r => r.after.promo === null && r.after.voucher === null && r.after.regular! > 0 && r.provenance?.not_direct_hita_verified === true)).toBe(true)
    const none = buildCandidatePlan({ csvText: text, expectedCsvSha256: sha256(text), approval: null, candidateSha: SHA, db, dbSizeBytes: 293_328_563, brand, state, now: NOW })
    expect(none.stopReasons).toContain('OWNER_APPROVAL_MISSING')
  })
})
