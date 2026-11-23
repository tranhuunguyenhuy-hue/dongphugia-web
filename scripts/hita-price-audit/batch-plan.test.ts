import { describe, expect, it } from 'vitest'
import { isSyntheticFixtureSku, planScope, validateInventory } from './batch-plan.mts'

describe('#448 scope', () => {
  it('classifies synthetic fixtures so they are never sent to Hita', () => {
    for (const sku of ['FX-M3-001', 'fx-xbrand-001', 'UAT-MWLVE786']) expect(isSyntheticFixtureSku(sku)).toBe(true)
    for (const sku of ['LT533R#XW', 'AC-4005VN/BW1', '119198', 'TLG11201B#PN']) expect(isSyntheticFixtureSku(sku)).toBe(false)
  })
  it('splits an inventory and counts active real SKUs', () => {
    const scope = planScope(validateInventory([
      { id: 1, sku: 'FX-M3-001', is_active: true }, { id: 2, sku: 'LT533R#XW', is_active: true },
      { id: 3, sku: 'TLG11201B#MBL', is_active: false },
    ]))
    expect(scope).toMatchObject({ total: 3, activeToCrawl: 1 })
    expect(scope.toCrawl.map(r => r.sku)).toEqual(['LT533R#XW', 'TLG11201B#MBL'])
    expect(scope.skipped.map(r => r.sku)).toEqual(['FX-M3-001'])
  })
  it('rejects malformed, duplicate (case-insensitive) or other-category inventory', () => {
    expect(() => validateInventory([])).toThrow('INVENTORY_EMPTY')
    expect(() => validateInventory([{ id: 1, sku: ' ', is_active: true }])).toThrow('INVENTORY_ROW_INVALID')
    expect(() => validateInventory([{ id: 1, sku: 'A', is_active: true }, { id: 2, sku: 'a', is_active: true }])).toThrow('INVENTORY_DUPLICATE')
    expect(() => validateInventory([{ id: 1, sku: 'A', is_active: true, category: 'thiet-bi-bep' }])).toThrow('INVENTORY_ROW_INVALID')
  })
})
