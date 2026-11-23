import { desiredPrices, planChange, PRICE_KEYS, type Current, type Prices, type SourceRow } from './pricing-policy.mts'
import type { InventoryRow } from './batch-plan.mts'

// #448 importer core. Writes ONLY the three canonical price columns, through the audited Admin API (optimistic version lock),
// and only for SKUs that are in the sanitary inventory of the isolated TEST project. Every write is ledgered (before/after),
// verified by a read-back, idempotent (equal values are a NOOP) and reversible (rollback restores `before`).
export type Product = { id: number; sku: string; category_id: number; version: number; regular_price_vnd: unknown; promotional_price_vnd: unknown; online_voucher_amount_vnd: unknown }
export type PatchResult = { status: number; code?: string }
export interface AdminClient {
  get(id: number): Promise<Product>
  patch(id: number, expectedVersion: number, input: Prices): Promise<PatchResult>
}
export type ResultRow = SourceRow & { dpg_id: number; dpg_sku: string; source_url?: string; retrieved_at_utc?: string | null }
export type LedgerEntry = {
  ts: string; run_id: string; id: number; sku: string; outcome: 'APPLIED' | 'FAILED' | 'ROLLED_BACK' | 'ROLLBACK_SKIPPED'
  version_before: number; version_after?: number; before: Prices; after: Prices; source_status?: string; source_url?: string; retrieved_at_utc?: string | null; detail?: string
}
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v))
export const pricesOf = (p: Product): Prices => ({ regular_price_vnd: num(p.regular_price_vnd), promotional_price_vnd: num(p.promotional_price_vnd), online_voucher_amount_vnd: num(p.online_voucher_amount_vnd) })
const same = (a: Prices, b: Prices) => PRICE_KEYS.every(k => a[k] === b[k])

export type PlanItem =
  | { kind: 'NOOP'; id: number; sku: string; current: Current; after: Prices; before: Prices; changed: string[]; row: ResultRow }
  | { kind: 'UPDATE'; id: number; sku: string; current: Current; after: Prices; before: Prices; changed: string[]; row: ResultRow }
  | { kind: 'SKIP' | 'QUARANTINE' | 'REFUSED'; id: number; sku: string; reason: string; row?: ResultRow }

export async function planImport({ rows, inventory, client, categoryId }: { rows: ResultRow[]; inventory: InventoryRow[]; client: AdminClient; categoryId: number }) {
  const scope = new Map(inventory.map(r => [r.id, r]))
  const items: PlanItem[] = []
  for (const row of rows) {
    const inv = scope.get(row.dpg_id)
    if (!inv || inv.sku !== row.dpg_sku) { items.push({ kind: 'REFUSED', id: row.dpg_id, sku: row.dpg_sku, reason: 'NOT_IN_SANITARY_INVENTORY', row }); continue }
    const desired = desiredPrices(row)
    if (desired.action === 'SKIP') { items.push({ kind: 'SKIP', id: row.dpg_id, sku: row.dpg_sku, reason: desired.reason, row }); continue }
    if (desired.action === 'QUARANTINE') { items.push({ kind: 'QUARANTINE', id: row.dpg_id, sku: row.dpg_sku, reason: desired.reason, row }); continue }
    const product = await client.get(row.dpg_id)
    if (product.id !== row.dpg_id || product.sku !== row.dpg_sku) { items.push({ kind: 'REFUSED', id: row.dpg_id, sku: row.dpg_sku, reason: 'DB_SKU_MISMATCH', row }); continue }
    if (product.category_id !== categoryId) { items.push({ kind: 'REFUSED', id: row.dpg_id, sku: row.dpg_sku, reason: 'WRONG_CATEGORY', row }); continue }
    const current: Current = { ...pricesOf(product), version: product.version }
    const change = planChange(current, desired.prices)
    items.push(change.kind === 'NOOP'
      ? { kind: 'NOOP', id: row.dpg_id, sku: row.dpg_sku, current, after: desired.prices, before: pricesOf(product), changed: [], row }
      : { kind: 'UPDATE', id: row.dpg_id, sku: row.dpg_sku, current, after: change.after, before: change.before, changed: change.changed, row })
  }
  return items
}

export async function applyPlan({ items, client, runId, appendLedger, batchSize = 10, maxWrites = Infinity, pause = async () => {}, now = () => new Date() }: {
  items: PlanItem[]; client: AdminClient; runId: string; appendLedger: (e: LedgerEntry) => Promise<void>
  batchSize?: number; maxWrites?: number; pause?: () => Promise<void>; now?: () => Date
}) {
  const updates = items.filter((i): i is Extract<PlanItem, { kind: 'UPDATE' }> => i.kind === 'UPDATE')
  const applied: number[] = [], failed: Array<{ id: number; detail: string }> = []
  let halted: string | null = null, writes = 0
  for (const [index, item] of updates.entries()) {
    if (writes >= maxWrites) { halted = 'MAX_WRITES_REACHED'; break }
    const base = { ts: now().toISOString(), run_id: runId, id: item.id, sku: item.sku, version_before: item.current.version, before: item.before, after: item.after,
      source_status: item.row.status, source_url: item.row.source_url, retrieved_at_utc: item.row.retrieved_at_utc }
    let version = item.current.version
    let result = await client.patch(item.id, version, item.after)
    if (result.code === 'VERSION_CONFLICT') {            // someone edited the product: re-read once and re-evaluate against the fresh state
      const fresh = await client.get(item.id)
      const again = planChange({ ...pricesOf(fresh), version: fresh.version }, item.after)
      if (again.kind === 'NOOP') { applied.push(item.id); continue }
      version = fresh.version
      result = await client.patch(item.id, version, item.after)
    }
    if (result.status !== 200) { const detail = `PATCH_${result.status}_${result.code ?? 'ERROR'}`; failed.push({ id: item.id, detail }); await appendLedger({ ...base, outcome: 'FAILED', detail }); halted = 'WRITE_FAILED'; break }
    const check = await client.get(item.id)
    if (!same(pricesOf(check), item.after)) { const detail = 'READ_BACK_MISMATCH'; failed.push({ id: item.id, detail }); await appendLedger({ ...base, outcome: 'FAILED', detail, version_after: check.version }); halted = 'READ_BACK_MISMATCH'; break }
    await appendLedger({ ...base, version_before: version, outcome: 'APPLIED', version_after: check.version })
    applied.push(item.id); writes++
    if ((index + 1) % batchSize === 0) await pause()
  }
  return { applied, failed, halted, planned: updates.length }
}

export async function rollbackLedger({ entries, client, runId, appendLedger, now = () => new Date() }: {
  entries: LedgerEntry[]; client: AdminClient; runId: string; appendLedger: (e: LedgerEntry) => Promise<void>; now?: () => Date
}) {
  const latest = new Map<number, LedgerEntry>()
  for (const e of entries) if (e.outcome === 'APPLIED') latest.set(e.id, e)       // the last applied change per product
  const restored: number[] = [], skipped: Array<{ id: number; detail: string }> = []
  for (const e of [...latest.values()].reverse()) {
    const fresh = await client.get(e.id)
    const base = { ts: now().toISOString(), run_id: runId, id: e.id, sku: e.sku, version_before: fresh.version, before: pricesOf(fresh), after: e.before }
    if (!same(pricesOf(fresh), e.after)) { skipped.push({ id: e.id, detail: 'CHANGED_SINCE_IMPORT' }); await appendLedger({ ...base, outcome: 'ROLLBACK_SKIPPED', detail: 'CHANGED_SINCE_IMPORT' }); continue }
    const result = await client.patch(e.id, fresh.version, e.before)
    const check = result.status === 200 ? await client.get(e.id) : fresh
    if (result.status !== 200 || !same(pricesOf(check), e.before)) { skipped.push({ id: e.id, detail: `ROLLBACK_FAILED_${result.status}` }); await appendLedger({ ...base, outcome: 'ROLLBACK_SKIPPED', detail: `ROLLBACK_FAILED_${result.status}` }); continue }
    await appendLedger({ ...base, outcome: 'ROLLED_BACK', version_after: check.version }); restored.push(e.id)
  }
  return { restored, skipped }
}
