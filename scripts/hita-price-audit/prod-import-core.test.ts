import { describe, expect, it } from 'vitest'
import { applySql, buildPlan, DB_CEILING_BYTES, releaseBindingMatches, ledgerJsonl, rollbackSql, sha256, type DbRow, type PlanInput } from './prod-import-core.mts'
import { REQUIRED_COLUMNS } from './quality-gate-core.mts'

const NOW = new Date('2026-11-24T01:00:00Z'), CAND = 'a'.repeat(40)
const COLS = [...REQUIRED_COLUMNS, 'product_name', 'reason', 'category']
const base: Record<string, string> = { dpg_id: '1', sku: 'A-1', is_active: 'true', category: 'thiet-bi-ve-sinh', hita_exact_sku: 'A-1', hita_url: 'https://hita.com.vn/a-1-100.html', regular_price_vnd: '1000000',
  promotional_price_vnd: '900000', online_voucher_amount_vnd: '50000', currency: 'VND', source_checked_at_utc: '2026-11-23T18:00:00.000Z', price_valid_until: '2026-12-01', voucher_condition: 'Online',
  status: 'EXACT', review_status: 'FRESH_CRAWL_PENDING_OWNER_REVIEW', product_name: 'A', reason: '' }
const csv = (rows: Array<Record<string, string>>) => [COLS.join(','), ...rows.map(r => COLS.map(c => `"${(({ ...base, ...r })[c] ?? '').replaceAll('"', '""')}"`).join(','))].join('\r\n') + '\r\n'
const row = (id: number, o: Record<string, string> = {}) => ({ dpg_id: String(id), sku: `S-${id}`, hita_exact_sku: `S-${id}`, hita_url: `https://hita.com.vn/s-${id}-${id}.html`, ...o })
const dbRow = (id: number, o: Partial<DbRow> = {}): DbRow => ({ id, sku: `S-${id}`, category_id: 1, brand_id: 1, is_active: true, version: 3, canonical_price_status: null, canonical_price_checked_at: null, ...o })
function input(rows: Array<Record<string, string>>, over: Partial<PlanInput> = {}, db?: DbRow[]): PlanInput {
  const text = csv(rows)
  return { csvText: text, expectedCsvSha256: sha256(text), candidateSha: CAND, inventory: rows.map(r => ({ id: Number(r.dpg_id), sku: r.sku, is_active: (r.is_active ?? 'true') === 'true' })),
    db: db ?? rows.map(r => dbRow(Number(r.dpg_id), { sku: r.sku, is_active: (r.is_active ?? 'true') === 'true' })), dbSizeBytes: 280 * 1024 * 1024, now: NOW, ...over }
}
const R = [row(1), row(2, { status: 'CONTACT', regular_price_vnd: '', promotional_price_vnd: '', online_voucher_amount_vnd: '', voucher_condition: '' }), row(3, { status: 'NOT_FOUND', hita_exact_sku: '', regular_price_vnd: '', promotional_price_vnd: '', online_voucher_amount_vnd: '', voucher_condition: '', hita_url: '' }),
  row(4, { status: 'DISCONTINUED', regular_price_vnd: '', promotional_price_vnd: '', online_voucher_amount_vnd: '', voucher_condition: '' }), row(5, { status: 'BLOCKED', regular_price_vnd: '', promotional_price_vnd: '', online_voucher_amount_vnd: '', voucher_condition: '', review_status: 'BLOCKED_NOT_NO_PRICE' })]

describe('#470 prod import planner', () => {
  it('maps each Hita outcome to its own stored status and never writes an unverified row', () => {
    const p = buildPlan(input(R))
    expect(p.stopReasons).toEqual([])
    const by = Object.fromEntries(p.rows.map(r => [r.id, r.after]))
    expect(by[1]).toEqual({ status: 'PRICE_VERIFIED', regular: 1000000, promo: 900000, voucher: 50000 })
    expect(by[2]).toEqual({ status: 'CONTACT_VERIFIED', regular: null, promo: null, voucher: null })
    expect(by[3].status).toBe('NOT_FOUND'); expect(by[4].status).toBe('DISCONTINUED')
    expect(by[5]).toBeUndefined()                       // BLOCKED: untouched, can never become CONTACT_VERIFIED
    expect(p.summary.skipped_unverified).toBe(1)
  })
  it('is idempotent: a DB already at the target state plans zero changes', () => {
    const first = buildPlan(input(R)); const db = R.map(r => { const t = first.rows.find(x => x.id === Number(r.dpg_id))
      return dbRow(Number(r.dpg_id), t ? { canonical_price_status: t.after.status, regular_price_vnd: t.after.regular, promotional_price_vnd: t.after.promo, online_voucher_amount_vnd: t.after.voucher } : {}) })
    const again = buildPlan(input(R, {}, db)); expect(again.rows).toHaveLength(0); expect(again.summary.unchanged).toBe(4)
  })
  it('stops on a CSV checksum mismatch / missing expected checksum / bad candidate sha', () => {
    expect(buildPlan(input(R, { expectedCsvSha256: 'b'.repeat(64) })).stopReasons.join()).toMatch(/CSV_SHA256_MISMATCH/)
    expect(buildPlan(input(R, { expectedCsvSha256: '' })).stopReasons).toContain('EXPECTED_CSV_SHA256_MISSING_OR_MALFORMED')
    expect(buildPlan(input(R, { candidateSha: 'abc' })).stopReasons).toContain('CANDIDATE_SHA_MISSING_OR_MALFORMED')
  })
  it('stops when id+SKU+category+is_active disagree with the live row', () => {
    for (const bad of [dbRow(1, { sku: 'OTHER' }), dbRow(1, { category_id: 2 }), dbRow(1, { is_active: false })]) {
      const p = buildPlan(input([R[0]], {}, [bad])); expect(p.stopReasons.join()).toMatch(/IDENTITY_MISMATCH id=1/)
    }
    expect(buildPlan(input([R[0]], {}, [])).stopReasons.join()).toMatch(/IDENTITY_MISMATCH/)
  })
  it('stops on a quality-gate FAIL (voucher >= selling price)', () => {
    const p = buildPlan(input([row(1, { online_voucher_amount_vnd: '900000' })])); expect(p.stopReasons.join()).toMatch(/QUALITY_GATE_FAIL/)
  })
  it('one plan = one state: active by default; the inactive set only via an explicit, separate plan; is_active never changes', () => {
    const rows = [row(1), row(2, { is_active: 'false' })]
    const active = buildPlan(input(rows)), inactive = buildPlan(input(rows, { state: 'inactive' }))
    expect(active.rows.map(r => r.id)).toEqual([1]); expect(inactive.rows.map(r => r.id)).toEqual([2])
    expect(active.planSha).not.toBe(inactive.planSha)                                    // independent checksums
    expect(active.summary).toMatchObject({ state: 'active', skipped_other_state: 1 }); expect(inactive.summary).toMatchObject({ state: 'inactive', skipped_other_state: 1 })
    expect(applySql(active, 0)).toContain('p.is_active = true and p.is_active = v.is_active'); expect(applySql(inactive, 0)).toContain('p.is_active = false and p.is_active = v.is_active')
    const setClause = (s: string) => s.slice(s.indexOf('update dpg_app.products p set'), s.indexOf('from (values'))
    expect(setClause(applySql(inactive, 0))).not.toContain('is_active'); expect(setClause(rollbackSql(inactive, 0))).not.toContain('is_active')   // the update never writes is_active
    expect(rollbackSql(inactive, 0)).toContain('p.is_active = false')
    expect(buildPlan(input(rows, { state: 'both' as never })).stopReasons).toContain('STATE_INVALID')
  })
  it('one plan = one brand: INAX and TOTO plans are independent, pinned to their own id+slug, and never mix rows', () => {
    const rows = [row(1), row(2)]
    const db = [dbRow(1, { brand_id: 1 }), dbRow(2, { brand_id: 2 })]
    const toto = buildPlan(input(rows, {}, db)), inax = buildPlan(input(rows, { brand: 'inax' }, db))
    expect(toto.stopReasons.join()).toMatch(/IDENTITY_MISMATCH id=2/)                     // an INAX row inside a TOTO plan stops it
    expect(inax.stopReasons.join()).toMatch(/IDENTITY_MISMATCH id=1/)
    const onlyInax = buildPlan(input([row(2)], { brand: 'inax' }, [dbRow(2, { brand_id: 2 })]))
    expect(onlyInax.stopReasons).toEqual([]); expect(onlyInax.summary).toMatchObject({ brand: 'inax', brand_id: 2 })
    const sql = applySql(onlyInax, 0)
    expect(sql).toContain("id = 2 and slug = 'inax'"); expect(sql).toContain('p.brand_id = 2')
    expect(onlyInax.planSha).not.toBe(buildPlan(input([row(2)], {}, [dbRow(2, { brand_id: 1 })])).planSha)
    expect(buildPlan(input(rows, { brand: 'american-standard' as never })).stopReasons).toContain('BRAND_NOT_APPROVED')
    expect(JSON.parse(ledgerJsonl(onlyInax).trim())).toMatchObject({ brand: 'inax', brand_id: 2, state: 'active' })
  })
  it('size guard: stops before any write when projected size leaves < 8 MiB under the 350 MiB trigger', () => {
    const p = buildPlan(input(R, { dbSizeBytes: DB_CEILING_BYTES - 8 * 1024 * 1024 - 100 })); expect(p.stopReasons.join()).toMatch(/DB_HEADROOM_INSUFFICIENT/)
    expect(buildPlan(input(R, { dbSizeBytes: 280 * 1024 * 1024 })).stopReasons).toEqual([])
  })
  it('splits into batches and binds every SQL file to the plan sha, with row-count and optimistic-basis checks', () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(i + 1)); const p = buildPlan(input(rows, { batchSize: 2 }))
    expect(p.batches.map(b => b.length)).toEqual([2, 2, 1])
    const sql = applySql(p, 0)
    expect(sql).toContain(p.planSha); expect(sql).toContain("'PRICE_VERIFIED'::text"); expect(sql).toContain('PRICE_IMPORT_ROWCOUNT_MISMATCH'); expect(sql).toContain('PRICE_IMPORT_PLAN_SHA_MISMATCH')
    expect(sql).toContain('PRICE_IMPORT_HEADROOM_STOP'); expect(sql).toContain('is not distinct from v.from_regular'); expect(sql).toContain('p.category_id = 1'); expect(sql).toMatch(/begin;[\s\S]*commit;/)
    expect(sql).toContain('n <> 2')
  })
  it('rollback SQL swaps before/after and clears the checked-at stamp; ledger has one line per row', () => {
    const p = buildPlan(input(R)); const rb = rollbackSql(p, 0)
    // rollback: basis = imported state at version v+1 with the CSV checked-at; target = exact prior state (incl. its checked-at)
    expect(rb).toContain("(1, 'S-1', true, 4, 'PRICE_VERIFIED'::text, 1000000, 900000, 50000, '2026-11-23T18:00:00.000Z'::timestamptz, null::text, null::bigint, null::bigint, null::bigint, null::timestamptz)")
    expect(applySql(p, 0)).toContain("(1, 'S-1', true, 3, null::text, null::bigint, null::bigint, null::bigint, null::timestamptz, 'PRICE_VERIFIED'::text, 1000000, 900000, 50000, '2026-11-23T18:00:00.000Z'::timestamptz)")
    expect(ledgerJsonl(p).trim().split('\n')).toHaveLength(p.rows.length)
  })
  it('the Owner GO token must quote candidate:csv:plan exactly and the plan must be free of stop reasons', () => {
    const p = buildPlan(input(R)); expect(releaseBindingMatches(p, p.releaseBinding)).toBe(true)
    expect(releaseBindingMatches(p, undefined)).toBe(false); expect(releaseBindingMatches(p, `${CAND}:${p.csvSha256}:${'0'.repeat(64)}`)).toBe(false)
    const bad = buildPlan(input(R, { candidateSha: 'x' })); expect(releaseBindingMatches(bad, bad.releaseBinding)).toBe(false)
  })
  it('refuses SKUs that are not safe SQL literals', () => {
    const p = buildPlan(input([row(1, { sku: "A'; drop", hita_exact_sku: "A'; drop" })])); expect(p.stopReasons.join()).toMatch(/IDENTITY_MISMATCH|QUALITY_GATE_FAIL/)
  })
  it('pins the immutable brand identity: a row of another brand stops the plan; every batch re-checks brand, target identity, schema and version', () => {
    expect(buildPlan(input([R[0]], {}, [dbRow(1, { brand_id: 2 })])).stopReasons.join()).toMatch(/IDENTITY_MISMATCH id=1/)
    expect(buildPlan(input([R[0]], {}, [dbRow(1, { version: undefined })])).stopReasons.join()).toMatch(/IDENTITY_MISMATCH/)
    const sql = applySql(buildPlan(input(R)), 0)
    for (const s of ["p.brand_id = 1", "id = 1 and slug = 'toto'", "p.version = v.from_version", "p.canonical_price_checked_at is not distinct from v.from_checked", "project_name = 'dongphugia-runtime'",
      "region = 'ap-southeast-1'", "environment = 'preview'", 'PRICE_IMPORT_BRAND_IDENTITY_CHANGED', 'PRICE_IMPORT_SCHEMA_001_MISSING']) expect(sql).toContain(s)
  })
  it('never overwrites a newer DB value (e.g. an Admin edit after the crawl): row skipped and listed', () => {
    const p = buildPlan(input([R[0], row(2)], {}, [dbRow(1, { canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: 5, canonical_price_checked_at: '2026-11-24T00:30:00.000Z' }), dbRow(2)]))
    expect(p.rows.map(r => r.id)).toEqual([2]); expect(p.summary).toMatchObject({ skipped_newer_db_edit: 1, newer_db_edit_ids: [1] })
  })
  it('the plan SHA changes when the basis (version / prior state) changes, so a GO for one snapshot cannot run on another', () => {
    const a = buildPlan(input([R[0]], {}, [dbRow(1)])), b = buildPlan(input([R[0]], {}, [dbRow(1, { version: 4 })]))
    expect(a.planSha).not.toBe(b.planSha)
  })
})
