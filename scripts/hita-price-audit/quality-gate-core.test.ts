import { describe, expect, it } from 'vitest'
import { exportClass, parseCsv, parseCsvDetailed, REQUIRED_COLUMNS, summarise, validate } from './quality-gate-core.mts'

const NOW = new Date('2026-11-23T20:00:00Z')
const COLS = [...REQUIRED_COLUMNS, 'product_name', 'reason']
const base = { dpg_id: '1', sku: 'A-1', is_active: 'true', hita_exact_sku: 'A-1', hita_url: 'https://hita.com.vn/a-1-100.html', regular_price_vnd: '1000000', promotional_price_vnd: '900000',
  online_voucher_amount_vnd: '50000', currency: 'VND', source_checked_at_utc: '2026-11-23T18:00:00.000Z', price_valid_until: '2026-12-01', voucher_condition: 'Ưu đãi khi đặt Online',
  status: 'EXACT', review_status: 'FRESH_CRAWL_PENDING_OWNER_REVIEW', product_name: 'Chậu, "A"', reason: '' }
const csv = (rows: Array<Partial<typeof base>>, cols: readonly string[] = COLS) => '﻿' + [cols.join(','), ...rows.map(r => cols.map(c => `"${String((({ ...base, ...r }) as Record<string, string>)[c] ?? '').replaceAll('"', '""')}"`).join(','))].join('\r\n') + '\r\n'
const row = (over: Partial<typeof base>, opts = {}) => { const r = validate(csv([over]), { now: NOW, ...opts }); return { r, codes: r.issues.map(i => `${i.severity}:${i.code}`), k: r.klass[0] } }

describe('#466-A CSV quality gate', () => {
  it('parses BOM, CRLF, quotes, embedded commas and doubled quotes', () => {
    const t = parseCsv('﻿a,b\r\n"x,1","He said ""hi"""\r\n"line\nbreak",z\n')
    expect(t).toEqual([['a', 'b'], ['x,1', 'He said "hi"'], ['line\nbreak', 'z']])
  })
  it('accepts a clean EXACT row as PRICE_VERIFIED with no issues (a human still has to approve)', () => {
    const { codes, k } = row({})
    expect(codes).toEqual([]); expect(k).toBe('PRICE_VERIFIED')
  })
  it('hard-fails missing/duplicate columns at file level', () => {
    expect(validate(csv([{}], COLS.filter(c => c !== 'currency')), { now: NOW }).fileIssues).toContain('MISSING_COLUMN:currency')
    expect(validate(csv([{}], [...COLS, 'sku']), { now: NOW }).fileIssues).toContain('DUPLICATE_COLUMN')
  })
  it('price rules: regular>promo>voucher, positive integers only, blank is not 0', () => {
    expect(row({ promotional_price_vnd: '1000000' }).codes).toContain('FAIL:PROMO_NOT_BELOW_REGULAR')
    expect(row({ promotional_price_vnd: '1200000' }).codes).toContain('FAIL:PROMO_NOT_BELOW_REGULAR')
    expect(row({ online_voucher_amount_vnd: '900000' }).codes).toContain('FAIL:VOUCHER_NOT_BELOW_SELLING')
    expect(row({ promotional_price_vnd: '', online_voucher_amount_vnd: '1000000' }).codes).toContain('FAIL:VOUCHER_NOT_BELOW_SELLING')
    for (const bad of ['0', '-5', '1.000.000', '1000000.5', '1e6', '1,000', ' 5']) expect(row({ regular_price_vnd: bad }).codes, bad).toContain('FAIL:PRICE_FORMAT')
    expect(row({ regular_price_vnd: '', promotional_price_vnd: '', online_voucher_amount_vnd: '' }).codes).toContain('FAIL:REGULAR_MISSING')
    expect(row({ promotional_price_vnd: '', online_voucher_amount_vnd: '' }).codes).toEqual([])   // regular only is valid
  })
  it('voucher needs a condition; a non-online condition is only a warning', () => {
    expect(row({ voucher_condition: '' }).codes).toContain('FAIL:VOUCHER_WITHOUT_CONDITION')
    expect(row({ voucher_condition: 'Cashback chung' }).codes).toEqual(['WARN:VOUCHER_CONDITION_NOT_ONLINE'])
  })
  it('non-EXACT outcomes must carry no price; unresolved statuses reach no conclusion', () => {
    expect(row({ status: 'CONTACT' }).codes).toContain('FAIL:PRICE_ON_NON_EXACT')
    const blank = { regular_price_vnd: '', promotional_price_vnd: '', online_voucher_amount_vnd: '', currency: '', price_valid_until: '', voucher_condition: '' }
    for (const status of ['BLOCKED', 'UNKNOWN', 'NOT_CRAWLED']) expect(row({ ...blank, hita_exact_sku: '', hita_url: '', source_checked_at_utc: '', status, review_status: 'NOT_CHECKED' }).k, status).toBe('UNRESOLVED')
    expect(row({ ...blank, hita_exact_sku: '', hita_url: '', source_checked_at_utc: '', status: 'NOT_CRAWLED', review_status: 'NOT_CHECKED', regular_price_vnd: '0' }).codes).toContain('FAIL:PRICE_ON_NON_EXACT')
  })
  it('CONTACT, NOT_FOUND, AMBIGUOUS and DISCONTINUED are four separate classes (Owner rule 24/11)', () => {
    const blank = { regular_price_vnd: '', promotional_price_vnd: '', online_voucher_amount_vnd: '', currency: '', price_valid_until: '', voucher_condition: '' }
    const onPage = { ...blank, hita_exact_sku: 'A-1', hita_url: 'https://hita.com.vn/a-1-100.html' }
    const off = { ...blank, hita_exact_sku: '', hita_url: '' }
    expect(row({ ...onPage, status: 'CONTACT' })).toMatchObject({ codes: [], k: 'CONTACT_VERIFIED' })
    expect(row({ ...onPage, status: 'DISCONTINUED' })).toMatchObject({ codes: [], k: 'DISCONTINUED_REVIEW' })
    expect(row({ ...off, status: 'NOT_FOUND' })).toMatchObject({ codes: [], k: 'NOT_FOUND_CANDIDATE_DELETE' })
    expect(row({ ...off, status: 'AMBIGUOUS' })).toMatchObject({ codes: [], k: 'AMBIGUOUS_UNVERIFIED' })
  })
  it('evidence rules for the non-priced outcomes: timestamp always, exact page for CONTACT/DISCONTINUED, no Hita SKU for NOT_FOUND', () => {
    const blank = { regular_price_vnd: '', promotional_price_vnd: '', online_voucher_amount_vnd: '', currency: '', price_valid_until: '', voucher_condition: '' }
    expect(row({ ...blank, hita_exact_sku: '', hita_url: '', status: 'NOT_FOUND', source_checked_at_utc: '' }).codes).toContain('FAIL:OUTCOME_WITHOUT_TIMESTAMP')
    expect(row({ ...blank, hita_exact_sku: 'OTHER', hita_url: 'https://hita.com.vn/a-1-100.html', status: 'CONTACT' }).codes).toContain('FAIL:OUTCOME_SKU_NOT_PROVEN')
    expect(row({ ...blank, hita_exact_sku: 'A-1', hita_url: '', status: 'CONTACT' }).codes).toContain('FAIL:OUTCOME_URL_INVALID')
    expect(row({ ...blank, hita_exact_sku: 'A-1', hita_url: '', status: 'NOT_FOUND' }).codes).toContain('FAIL:NOT_FOUND_WITH_HITA_SKU')
    expect(row({ ...blank, hita_exact_sku: 'A-1', hita_url: 'https://hita.com.vn/a-1-100.html', status: 'CONTACT', regular_price_vnd: '999000' }).codes).toContain('FAIL:PRICE_ON_NON_EXACT')   // old DPG price is never a fallback
  })
  it('stale pilot rows are never eligible', () => {
    expect(row({ review_status: 'STALE_PILOT_2026-11-22' }).k).toBe('UNRESOLVED')
  })
  it('exact SKU: mismatch fails, case-only difference warns', () => {
    expect(row({ hita_exact_sku: 'A-2' }).codes).toContain('FAIL:HITA_SKU_MISMATCH')
    expect(row({ hita_exact_sku: '' }).codes).toContain('FAIL:HITA_SKU_MISSING')
    expect(row({ hita_exact_sku: 'a-1' }).codes).toEqual(['WARN:SKU_CASE_DIFF'])
  })
  it('url, currency and timestamp checks', () => {
    for (const hita_url of ['http://hita.com.vn/a-1-100.html', 'https://evil.example/a-1-100.html', 'https://hita.com.vn/product/searchProduct?key=A-1', 'https://hita.com.vn/a-1-100.html?x=1', '']) expect(row({ hita_url }).codes, hita_url).toContain('FAIL:HITA_URL_INVALID')
    expect(row({ currency: 'USD' }).codes).toContain('FAIL:CURRENCY_NOT_VND')
    expect(row({ source_checked_at_utc: '2026-11-23 18:00' }).codes).toContain('FAIL:CHECKED_AT_INVALID')
    expect(row({ source_checked_at_utc: '2026-11-24T00:00:00Z' }).codes).toContain('FAIL:CHECKED_AT_IN_FUTURE')
  })
  it('freshness and expiry are warnings (Owner decision), not failures', () => {
    expect(row({ source_checked_at_utc: '2026-11-20T00:00:00Z' }).codes).toEqual(['WARN:CHECKED_STALE'])
    expect(row({ price_valid_until: '2026-11-20' }).codes).toEqual(['WARN:VALID_UNTIL_EXPIRED'])
    expect(row({ price_valid_until: '2026-11-24' }).codes).toEqual(['WARN:VALID_UNTIL_WITHIN_48H'])
    expect(row({ price_valid_until: '' }).codes).toEqual(['WARN:VALID_UNTIL_MISSING'])
    expect(row({ price_valid_until: 'soon' }).codes).toEqual(['WARN:VALID_UNTIL_INVALID'])
  })
  it('unusual values are flagged for review but never excluded', () => {
    const deep = row({ promotional_price_vnd: '400000' })
    expect(deep.codes).toEqual(['WARN:DEEP_DISCOUNT_REVIEW']); expect(deep.k).toBe('PRICE_VERIFIED')
    expect(row({ online_voucher_amount_vnd: '300000' }).codes).toEqual(['WARN:LARGE_VOUCHER_REVIEW'])
  })
  it('identity: duplicate id/sku (case-insensitive), whitespace, bad id, bad active flag, formula cells', () => {
    const r = validate(csv([{}, { dpg_id: '1', sku: 'x' }, { dpg_id: '2', sku: 'a-1' }, { dpg_id: '03', sku: 'B ' }, { dpg_id: '4', sku: 'C', is_active: 'yes' }, { dpg_id: '5', sku: '=1+1', hita_exact_sku: '=1+1' }]), { now: NOW })
    const codes = r.issues.filter(i => i.severity === 'FAIL').map(i => i.code)
    for (const c of ['DPG_ID_DUPLICATE', 'SKU_DUPLICATE', 'DPG_ID_INVALID', 'SKU_WHITESPACE', 'IS_ACTIVE_INVALID', 'FORMULA_CELL']) expect(codes, c).toContain(c)
    expect(r.klass[0]).toBe('PRICE_VERIFIED')    // the first occurrence stays valid; the duplicates are the failures
  })
  it('cross-checks id, exact SKU and active flag against an inventory', () => {
    const inventory = new Map([[1, { id: 1, sku: 'A-1', is_active: false }]])
    expect(row({}, { inventory }).codes).toEqual(['FAIL:INVENTORY_ACTIVE_MISMATCH'])
    expect(row({ dpg_id: '9' }, { inventory }).codes).toContain('FAIL:INVENTORY_ID_NOT_FOUND')
    expect(row({ sku: 'OTHER', hita_exact_sku: 'OTHER' }, { inventory: new Map([[1, { id: 1, sku: 'A-1', is_active: true }]]) }).codes).toContain('FAIL:INVENTORY_SKU_MISMATCH')
  })
  it('flags two SKUs pointing at the same Hita page (possible sibling mix-up) as a warning', () => {
    const r = validate(csv([{}, { dpg_id: '2', sku: 'A-2', hita_exact_sku: 'A-2' }]), { now: NOW })
    expect(r.issues.filter(i => i.code === 'HITA_URL_SHARED')).toHaveLength(2)
  })
  it('summary counts rows by class and issues by code', () => {
    const r = validate(csv([{}, { dpg_id: '2', sku: 'B', promotional_price_vnd: '2000000' }, { dpg_id: '3', sku: 'C', status: 'NOT_CRAWLED', review_status: 'NOT_CHECKED', regular_price_vnd: '', promotional_price_vnd: '', online_voucher_amount_vnd: '' }]), { now: NOW })
    const s = summarise(r)
    expect(s.by_class).toEqual({ INVALID: 1, PRICE_VERIFIED: 1, UNRESOLVED: 1 })
    expect(s.fail_by_code).toMatchObject({ PROMO_NOT_BELOW_REGULAR: 1 })
  })

  it('detects malformed CSV: ragged rows, unterminated and misplaced quotes', () => {
    const good = csv([{}])
    const ragged = good.replace('\r\n', '\r\n').trimEnd() + '\r\n"9","only-two-cells"\r\n'
    expect(validate(ragged, { now: NOW }).issues.some(i => i.code === 'ROW_COLUMN_COUNT' && i.severity === 'FAIL')).toBe(true)
    expect(validate(good + '"1","abc\r\n', { now: NOW }).fileIssues).toContain('UNTERMINATED_QUOTE')
    expect(parseCsvDetailed('a,b\r\nx"y,z\r\n').strayQuoteRows).toEqual([2])
    expect(parseCsvDetailed('a,b\r\n"x"y,z\r\n').strayQuoteRows).toEqual([2])
    expect(parseCsvDetailed('a,b\r\n"x",""\r\n').strayQuoteRows).toEqual([])
    const stray = validate(good.replace('"A-1"', '"A-1"x'), { now: NOW })
    expect(stray.issues.map(i => i.code)).toContain('STRAY_QUOTE')
  })
  it('exports each class as a review list that is explicitly not a delete command', () => {
    const blank = { regular_price_vnd: '', promotional_price_vnd: '', online_voucher_amount_vnd: '', currency: '', price_valid_until: '', voucher_condition: '', hita_exact_sku: '', hita_url: '' }
    const r = validate(csv([{ ...blank, status: 'NOT_FOUND' }, { dpg_id: '2', sku: 'B' }]), { now: NOW })
    const list = exportClass(r, 'NOT_FOUND_CANDIDATE_DELETE', 'KHÔNG phải lệnh xóa')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ dpg_id: '1', sku: 'A-1', status: 'NOT_FOUND', regular_price_vnd: '', future_action: 'KHÔNG phải lệnh xóa' })
  })
})
