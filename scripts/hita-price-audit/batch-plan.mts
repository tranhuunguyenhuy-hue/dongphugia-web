import { skuKey } from './adapter.mts'
// #448 scope: SKUs of category `thiet-bi-ve-sinh` in TEST. Synthetic fixtures (FX-*, UAT-*) never exist on Hita, so they are
// recorded as SKIPPED/SYNTHETIC_FIXTURE and are NOT sent to a third-party site.
export type InventoryRow = { id: number; sku: string; is_active: boolean; category?: string; pdp_url?: string | null; brand?: string }
export const SYNTHETIC_PREFIX = /^(?:FX-|UAT-)/i
export const isSyntheticFixtureSku = (sku: string) => SYNTHETIC_PREFIX.test(sku.trim())

export function validateInventory(rows: unknown): InventoryRow[] {
  if (!Array.isArray(rows) || rows.length < 1) throw new Error('INVENTORY_EMPTY')
  const ids = new Set<number>(), skus = new Set<string>()
  for (const row of rows as InventoryRow[]) {
    if (!Number.isSafeInteger(row?.id) || row.id < 1 || typeof row.sku !== 'string' || !row.sku.trim() || row.sku.length > 120 ||
        typeof row.is_active !== 'boolean' || (row.pdp_url != null && typeof row.pdp_url !== 'string') ||
        (row.brand !== undefined && (typeof row.brand !== 'string' || !row.brand.trim())) || (row.category !== undefined && row.category !== 'thiet-bi-ve-sinh')) throw new Error('INVENTORY_ROW_INVALID')
    if (ids.has(row.id) || skus.has(skuKey(row.sku))) throw new Error('INVENTORY_DUPLICATE')
    ids.add(row.id); skus.add(skuKey(row.sku))
  }
  return rows as InventoryRow[]
}
export function planScope(rows: InventoryRow[]) {
  const toCrawl = rows.filter(r => !isSyntheticFixtureSku(r.sku))
  const skipped = rows.filter(r => isSyntheticFixtureSku(r.sku))
  return { total: rows.length, toCrawl, skipped, activeToCrawl: toCrawl.filter(r => r.is_active).length }
}
