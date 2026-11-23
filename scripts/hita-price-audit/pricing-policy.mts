// #448 price policy (Owner decision, locked): Hita EXACT SKU is the only source of the three canonical prices for
// `thiet-bi-ve-sinh`. No legacy/sibling fallback. Pure functions: no I/O, so every rule is unit-tested.
export type SourceStatus = 'EXACT' | 'AMBIGUOUS' | 'NOT_FOUND' | 'CONTACT' | 'DISCONTINUED' | 'BLOCKED' | 'UNKNOWN'
export type Prices = { regular_price_vnd: number | null; promotional_price_vnd: number | null; online_voucher_amount_vnd: number | null }
export type SourceRow = Prices & { status: SourceStatus | string; exception?: string | null }
export const NO_PRICE: Prices = { regular_price_vnd: null, promotional_price_vnd: null, online_voucher_amount_vnd: null }
export const PRICE_KEYS = ['regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd'] as const

export type Desired =
  | { action: 'WRITE'; prices: Prices; reason: 'EXACT' | 'NO_VALID_SOURCE_PRICE'; source_status: string }
  | { action: 'SKIP'; reason: 'TECHNICAL_NOT_VERIFIED' | 'SYNTHETIC_FIXTURE' | 'NOT_CRAWLED'; source_status: string }
  | { action: 'QUARANTINE'; reason: string; source_status: string }

const money = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

// Policy per status:
//  EXACT                                 -> write the three values, after the source is checked for internal consistency.
//  CONTACT/DISCONTINUED/NOT_FOUND/AMBIGUOUS -> all three NULL ("Liên hệ báo giá"); the SKU is never hidden or deleted.
//  BLOCKED/UNKNOWN                       -> a technical failure is not evidence of "no price": leave the DB untouched.
export function desiredPrices(row: SourceRow): Desired {
  const s = String(row.status)
  if (s === 'EXACT') {
    const { regular_price_vnd: r, promotional_price_vnd: p, online_voucher_amount_vnd: v } = row
    if (!money(r)) return { action: 'QUARANTINE', reason: 'EXACT_WITHOUT_REGULAR_PRICE', source_status: s }
    if (p !== null && (!money(p) || p >= (r as number))) return { action: 'QUARANTINE', reason: 'PROMOTIONAL_NOT_BELOW_REGULAR', source_status: s }
    if (v !== null && (!money(v) || v >= ((p ?? r) as number))) return { action: 'QUARANTINE', reason: 'VOUCHER_NOT_BELOW_SELLING_PRICE', source_status: s }
    return { action: 'WRITE', prices: { regular_price_vnd: r as number, promotional_price_vnd: p, online_voucher_amount_vnd: v }, reason: 'EXACT', source_status: s }
  }
  if (['CONTACT', 'DISCONTINUED', 'NOT_FOUND', 'AMBIGUOUS'].includes(s)) {
    return { action: 'WRITE', prices: { ...NO_PRICE }, reason: 'NO_VALID_SOURCE_PRICE', source_status: s }
  }
  return { action: 'SKIP', reason: 'TECHNICAL_NOT_VERIFIED', source_status: s }
}

export type Current = Prices & { version: number }
export type Change = { kind: 'NOOP' } | { kind: 'UPDATE'; before: Prices; after: Prices; changed: Array<typeof PRICE_KEYS[number]> }
export function planChange(current: Current, after: Prices): Change {
  const changed = PRICE_KEYS.filter(key => (current[key] ?? null) !== (after[key] ?? null))
  if (!changed.length) return { kind: 'NOOP' }
  return { kind: 'UPDATE', before: Object.fromEntries(PRICE_KEYS.map(k => [k, current[k] ?? null])) as Prices, after: { ...after }, changed }
}
