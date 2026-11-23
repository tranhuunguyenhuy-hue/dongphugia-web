import { describe, expect, it } from 'vitest'
import { applyPlan, planImport, rollbackLedger, type AdminClient, type LedgerEntry, type Product, type ResultRow } from './import-core.mts'

const P = (id: number, sku: string, r: number | null = null, p: number | null = null, v: number | null = null, version = 1, category_id = 4): Product =>
  ({ id, sku, category_id, version, regular_price_vnd: r === null ? null : String(r), promotional_price_vnd: p === null ? null : String(p), online_voucher_amount_vnd: v === null ? null : String(v) })
function memory(products: Product[], opts: { failPatchFor?: number; conflictOnce?: Set<number>; corruptReadBack?: Set<number> } = {}) {
  const db = new Map(products.map(p => [p.id, { ...p }])), log: Array<{ id: number; input: Record<string, unknown> }> = []
  const client: AdminClient = {
    async get(id) { const p = db.get(id)!; return { ...p, ...(opts.corruptReadBack?.has(id) && log.some(l => l.id === id) ? { regular_price_vnd: '1' } : {}) } },
    async patch(id, expected, input) {
      if (opts.failPatchFor === id) return { status: 500, code: 'INTERNAL' }
      if (opts.conflictOnce?.delete(id)) { db.get(id)!.version++; return { status: 409, code: 'VERSION_CONFLICT' } }
      const p = db.get(id)!
      if (p.version !== expected) return { status: 409, code: 'VERSION_CONFLICT' }
      log.push({ id, input: { ...input } }); Object.assign(p, Object.fromEntries(Object.entries(input).map(([k, v]) => [k, v === null ? null : String(v)])), { version: p.version + 1 }); return { status: 200 }
    },
  }
  return { db, log, client }
}
const inv = [{ id: 1, sku: 'A', is_active: true }, { id: 2, sku: 'B', is_active: true }, { id: 3, sku: 'C', is_active: true }, { id: 4, sku: 'D', is_active: false }]
const exact = (id: number, sku: string, r: number, p: number | null, v: number | null): ResultRow => ({ dpg_id: id, dpg_sku: sku, status: 'EXACT', regular_price_vnd: r, promotional_price_vnd: p, online_voucher_amount_vnd: v })
const none = (id: number, sku: string, status: string): ResultRow => ({ dpg_id: id, dpg_sku: sku, status, regular_price_vnd: null, promotional_price_vnd: null, online_voucher_amount_vnd: null })
const ledger = () => { const entries: LedgerEntry[] = []; return { entries, append: async (e: LedgerEntry) => { entries.push(e) } } }

describe('#448 importer', () => {
  it('plans UPDATE / NOOP / SKIP / QUARANTINE / REFUSED correctly, never touching unrelated products', async () => {
    const { client } = memory([P(1, 'A'), P(2, 'B', 100, 90, null), P(3, 'C', 500, 400, 20, 1, 9)])
    const items = await planImport({ client, inventory: inv, categoryId: 4, rows: [
      exact(1, 'A', 1000, 900, 50), exact(2, 'B', 100, 90, null), none(3, 'C', 'CONTACT'),
      none(4, 'D', 'BLOCKED'), exact(5, 'Z', 10, null, null), { ...exact(1, 'A', 10, 20, null), dpg_id: 1 },
    ] })
    expect(items.map(i => i.kind)).toEqual(['UPDATE', 'NOOP', 'REFUSED', 'SKIP', 'REFUSED', 'QUARANTINE'])
    expect(items[2]).toMatchObject({ reason: 'WRONG_CATEGORY' })
    expect(items[4]).toMatchObject({ reason: 'NOT_IN_SANITARY_INVENTORY' })
  })
  it('applies, writes only the three price keys, ledgers before/after and is idempotent on the second run', async () => {
    const m = memory([P(1, 'A'), P(2, 'B', 100, 90, 5)]); const l = ledger()
    const rows = [exact(1, 'A', 1000, 900, 50), none(2, 'B', 'NOT_FOUND')]
    const run1 = await applyPlan({ items: await planImport({ client: m.client, inventory: inv, categoryId: 4, rows }), client: m.client, runId: 'r1', appendLedger: l.append })
    expect(run1).toMatchObject({ applied: [1, 2], failed: [], halted: null })
    expect(m.log.every(w => Object.keys(w.input).sort().join() === 'online_voucher_amount_vnd,promotional_price_vnd,regular_price_vnd')).toBe(true)
    expect(l.entries[0]).toMatchObject({ outcome: 'APPLIED', id: 1, before: { regular_price_vnd: null }, after: { regular_price_vnd: 1000, promotional_price_vnd: 900, online_voucher_amount_vnd: 50 }, version_before: 1, version_after: 2 })
    expect(l.entries[1]).toMatchObject({ after: { regular_price_vnd: null, promotional_price_vnd: null, online_voucher_amount_vnd: null }, before: { regular_price_vnd: 100 } })
    const writes = m.log.length
    const again = await planImport({ client: m.client, inventory: inv, categoryId: 4, rows })
    expect(again.map(i => i.kind)).toEqual(['NOOP', 'NOOP'])
    expect((await applyPlan({ items: again, client: m.client, runId: 'r2', appendLedger: l.append })).applied).toEqual([])
    expect(m.log.length).toBe(writes)                 // no extra write, no version bump on rerun
  })
  it('re-reads once on VERSION_CONFLICT and still converges', async () => {
    const m = memory([P(1, 'A')], { conflictOnce: new Set([1]) }); const l = ledger()
    const items = await planImport({ client: m.client, inventory: inv, categoryId: 4, rows: [exact(1, 'A', 1000, null, null)] })
    expect(await applyPlan({ items, client: m.client, runId: 'r', appendLedger: l.append })).toMatchObject({ applied: [1], halted: null })
    expect(l.entries[0].version_before).toBe(2)
  })
  it('halts fail-fast on a failed write and on a read-back mismatch; later products are not touched', async () => {
    const fail = memory([P(1, 'A'), P(2, 'B')], { failPatchFor: 1 }); const l1 = ledger()
    const r1 = await applyPlan({ items: await planImport({ client: fail.client, inventory: inv, categoryId: 4, rows: [exact(1, 'A', 10, null, null), exact(2, 'B', 20, null, null)] }), client: fail.client, runId: 'r', appendLedger: l1.append })
    expect(r1).toMatchObject({ halted: 'WRITE_FAILED', applied: [] }); expect(fail.log).toHaveLength(0); expect(l1.entries[0]).toMatchObject({ outcome: 'FAILED' })
    const bad = memory([P(1, 'A'), P(2, 'B')], { corruptReadBack: new Set([1]) }); const l2 = ledger()
    const r2 = await applyPlan({ items: await planImport({ client: bad.client, inventory: inv, categoryId: 4, rows: [exact(1, 'A', 10, null, null), exact(2, 'B', 20, null, null)] }), client: bad.client, runId: 'r', appendLedger: l2.append })
    expect(r2.halted).toBe('READ_BACK_MISMATCH'); expect(bad.log.map(w => w.id)).toEqual([1])
  })
  it('honours maxWrites (batch size control)', async () => {
    const m = memory([P(1, 'A'), P(2, 'B'), P(3, 'C')])
    const items = await planImport({ client: m.client, inventory: inv, categoryId: 4, rows: [exact(1, 'A', 1, null, null), exact(2, 'B', 2, null, null), exact(3, 'C', 3, null, null)] })
    expect(await applyPlan({ items, client: m.client, runId: 'r', appendLedger: ledger().append, maxWrites: 2 })).toMatchObject({ applied: [1, 2], halted: 'MAX_WRITES_REACHED' })
  })
  it('rollback restores the before values and refuses to overwrite a later change', async () => {
    const m = memory([P(1, 'A', 7, null, null), P(2, 'B', 100, 90, 5)]); const l = ledger()
    const rows = [exact(1, 'A', 1000, 900, 50), none(2, 'B', 'CONTACT')]
    await applyPlan({ items: await planImport({ client: m.client, inventory: inv, categoryId: 4, rows }), client: m.client, runId: 'r1', appendLedger: l.append })
    await m.client.patch(2, m.db.get(2)!.version, { regular_price_vnd: 123, promotional_price_vnd: null, online_voucher_amount_vnd: null })   // an editor changes B after the import
    const rb = await rollbackLedger({ entries: l.entries, client: m.client, runId: 'rb', appendLedger: l.append })
    expect(rb.restored).toEqual([1]); expect(rb.skipped).toEqual([{ id: 2, detail: 'CHANGED_SINCE_IMPORT' }])
    expect(m.db.get(1)).toMatchObject({ regular_price_vnd: '7', promotional_price_vnd: null, online_voucher_amount_vnd: null })
    expect(m.db.get(2)).toMatchObject({ regular_price_vnd: '123' })
  })
})
