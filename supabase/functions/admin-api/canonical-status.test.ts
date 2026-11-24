import { afterEach, describe, expect, it } from 'vitest'
import { CANONICAL_ADMIN_BRANDS, CANONICAL_REACTIVATION_MAX_AGE_MS, resourceByKey, setExternalColumns } from './resources.ts'
import { CANONICAL_APPROVED_BRANDS } from '../../../src/lib/canonical-price'

// #470: the product write hook keeps `canonical_price_status` consistent with the three canonical prices so the Production
// CHECK (prices only with PRICE_VERIFIED) is never what rejects an admin edit; canonical prices exist only for approved brands.
const hook = resourceByKey('products')!.hook!
let scope: { brand: string | null; category: string | null } = { brand: 'toto', category: 'thiet-bi-ve-sinh' }
const tx = { query: async () => [scope] } as never
const run = async (existing: Record<string, unknown>, input: Record<string, unknown>, mode: 'create' | 'update' = 'update') =>
  hook({ mode, existing, input, tx, ctx: undefined as never, services: undefined as never }) as unknown as Promise<{ set?: Record<string, unknown> } | undefined>
const base = { is_active: false, stock_status: 'contact', list_price: null, sale_price: null, price: null }
const ON = ['regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd', 'canonical_price_status', 'canonical_price_checked_at']
afterEach(() => { setExternalColumns([]); scope = { brand: 'toto', category: 'thiet-bi-ve-sinh' } })

describe('#470 admin price edit keeps canonical_price_status consistent', () => {
  it('the Admin allowlist equals the runtime allowlist', () => { expect([...CANONICAL_ADMIN_BRANDS]).toEqual([...CANONICAL_APPROVED_BRANDS]) })
  it('does nothing when the database has no status column (TEST today)', async () => {
    setExternalColumns(['regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd'])
    expect(await run({ ...base }, { regular_price_vnd: 1000000 })).toBeUndefined()
  })
  it('sets PRICE_VERIFIED + checked-at when a price is entered', async () => {
    setExternalColumns(ON)
    const r = await run({ ...base, canonical_price_status: 'CONTACT_VERIFIED' }, { regular_price_vnd: 1000000 })
    expect(r?.set?.canonical_price_status).toBe('PRICE_VERIFIED'); expect(r?.set).toHaveProperty('canonical_price_checked_at')
  })
  it('clearing every price on a verified row hides the price (status cleared); other states are preserved', async () => {
    setExternalColumns(ON)
    const cleared = await run({ ...base, canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '1000000' }, { regular_price_vnd: null })
    expect(cleared?.set?.canonical_price_status).toBeNull()
    const kept = await run({ ...base, canonical_price_status: 'NOT_FOUND' }, { promotional_price_vnd: null })
    expect(kept?.set?.canonical_price_status).toBe('NOT_FOUND')
  })
  it('still rejects an invalid price relation before any status write', async () => {
    setExternalColumns(ON)
    await expect(run({ ...base, regular_price_vnd: '1000000' }, { promotional_price_vnd: 1000000 })).rejects.toMatchObject({ code: 'PRICE_RELATION_INVALID' })
  })
  it('does not touch the status on unrelated edits', async () => {
    setExternalColumns(['canonical_price_status'])
    expect(await run({ ...base, canonical_price_status: 'PRICE_VERIFIED' }, { name: 'x' })).toBeUndefined()
  })
  it('legacy guards still run when canonical prices are edited in the same request (no early return)', async () => {
    setExternalColumns(ON)
    await expect(run({ ...base, list_price: '100' }, { regular_price_vnd: 1000000, sale_price: 200 })).rejects.toMatchObject({ code: 'SALE_PRICE_INVALID' })
    await expect(run({ ...base, stock_status: 'in_stock', image_main_url: null }, { regular_price_vnd: 1000000, is_active: true })).rejects.toMatchObject({ code: 'IMAGE_REQUIRED' })
  })
})

describe('#470 canonical prices only for approved brands (other sanitary brands and categories keep legacy price management)', () => {
  it.each([['toto'], ['inax']])('%s: canonical price accepted', async brand => {
    setExternalColumns(ON); scope = { brand, category: 'thiet-bi-ve-sinh' }
    expect((await run({ ...base, brand_id: 1, category_id: 1 }, { regular_price_vnd: 1000000 }))?.set?.canonical_price_status).toBe('PRICE_VERIFIED')
  })
  it.each([[{ brand: 'american-standard', category: 'thiet-bi-ve-sinh' }], [{ brand: null, category: 'thiet-bi-ve-sinh' }], [{ brand: 'toto', category: 'gach-op-lat' }]])('%j: canonical price rejected, legacy path untouched', async s => {
    setExternalColumns(ON); scope = s
    await expect(run({ ...base, brand_id: 9, category_id: 1 }, { regular_price_vnd: 1000000 })).rejects.toMatchObject({ code: 'PRICE_SCOPE_INVALID' })
    // clearing prices (no price present) on an out-of-scope product is not blocked, and legacy edits never reach the scope check
    expect(await run({ ...base }, { regular_price_vnd: null })).toMatchObject({ set: { canonical_price_status: null } })
    expect(await run({ ...base, list_price: '200' }, { list_price: '300', price: 250 })).toBeUndefined()
  })
})

describe('#470 re-activation of an inactive SKU needs a fresh verified price (policy constant, Owner to confirm)', () => {
  const stale = new Date(Date.now() - CANONICAL_REACTIVATION_MAX_AGE_MS - 3600_000).toISOString(), fresh = new Date(Date.now() - 3600_000).toISOString()
  const inactive = (extra: Record<string, unknown>) => ({ ...base, stock_status: 'contact', image_main_url: 'https://dpg-products.b-cdn.net/a.webp', brand_id: 1, category_id: 1, ...extra })
  it('stale / unknown check time => PRICE_REVERIFIED required; fresh => allowed; new price in the same request => allowed', async () => {
    setExternalColumns(ON)
    await expect(run(inactive({ canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '5', canonical_price_checked_at: stale }), { is_active: true })).rejects.toMatchObject({ code: 'PRICE_REVERIFY_REQUIRED' })
    await expect(run(inactive({ canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '5', canonical_price_checked_at: null }), { is_active: true })).rejects.toMatchObject({ code: 'PRICE_REVERIFY_REQUIRED' })
    await run(inactive({ canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '5', canonical_price_checked_at: fresh }), { is_active: true })
    await run(inactive({ canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '5', canonical_price_checked_at: stale }), { is_active: true, regular_price_vnd: 6 })
  })
  it('does not apply to other states, other brands, already-active rows or edits that do not activate', async () => {
    setExternalColumns(ON)
    await run(inactive({ canonical_price_status: 'CONTACT_VERIFIED', canonical_price_checked_at: stale }), { is_active: true })
    await run(inactive({ canonical_price_status: null }), { is_active: true })
    await run({ ...inactive({ canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '5', canonical_price_checked_at: stale }), is_active: true }, { is_active: true })
    await run(inactive({ canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '5', canonical_price_checked_at: stale }), { name: 'x' })
    scope = { brand: 'american-standard', category: 'thiet-bi-ve-sinh' }
    await run(inactive({ canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '5', canonical_price_checked_at: stale }), { is_active: true })
  })
})
