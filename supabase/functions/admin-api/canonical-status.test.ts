import { afterEach, describe, expect, it } from 'vitest'
import { resourceByKey, setExternalColumns } from './resources.ts'

// #470: the product write hook keeps `canonical_price_status` consistent with the three canonical prices so the Production
// CHECK (prices only with PRICE_VERIFIED) is never what rejects an admin edit. Hook-only unit test: no database.
const hook = resourceByKey('products')!.hook!
const run = async (existing: Record<string, unknown>, input: Record<string, unknown>) =>
  hook({ mode: 'update', existing, input, tx: undefined as never, ctx: undefined as never, services: undefined as never }) as unknown as { set?: Record<string, unknown> } | undefined
const base = { is_active: false, stock_status: 'contact', list_price: null, sale_price: null, price: null }
afterEach(() => setExternalColumns([]))

describe('#470 admin price edit keeps canonical_price_status consistent', () => {
  it('does nothing when the database has no status column (TEST today)', async () => {
    setExternalColumns(['regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd'])
    expect(await run({ ...base }, { regular_price_vnd: 1000000 })).toBeUndefined()
  })
  it('sets PRICE_VERIFIED + checked-at when a price is entered', async () => {
    setExternalColumns(['regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd', 'canonical_price_status'])
    const r = await run({ ...base, canonical_price_status: 'CONTACT_VERIFIED' }, { regular_price_vnd: 1000000 })
    expect(r?.set?.canonical_price_status).toBe('PRICE_VERIFIED'); expect(r?.set).toHaveProperty('canonical_price_checked_at')
  })
  it('clearing every price on a verified row hides the price (status cleared); other states are preserved', async () => {
    setExternalColumns(['regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd', 'canonical_price_status'])
    const cleared = await run({ ...base, canonical_price_status: 'PRICE_VERIFIED', regular_price_vnd: '1000000' }, { regular_price_vnd: null })
    expect(cleared?.set?.canonical_price_status).toBeNull()
    const kept = await run({ ...base, canonical_price_status: 'NOT_FOUND' }, { promotional_price_vnd: null })
    expect(kept?.set?.canonical_price_status).toBe('NOT_FOUND')
  })
  it('still rejects an invalid price relation before any status write', async () => {
    setExternalColumns(['regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd', 'canonical_price_status'])
    await expect(run({ ...base, regular_price_vnd: '1000000' }, { promotional_price_vnd: 1000000 })).rejects.toMatchObject({ code: 'PRICE_RELATION_INVALID' })
  })
  it('does not touch the status on unrelated edits', async () => {
    setExternalColumns(['canonical_price_status'])
    expect(await run({ ...base, canonical_price_status: 'PRICE_VERIFIED' }, { name: 'x' })).toBeUndefined()
  })
  it('legacy guards still run when canonical prices are edited in the same request (no early return)', async () => {
    setExternalColumns(['regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd', 'canonical_price_status'])
    await expect(run({ ...base, list_price: '100' }, { regular_price_vnd: 1000000, sale_price: 200 })).rejects.toMatchObject({ code: 'SALE_PRICE_INVALID' })
    await expect(run({ ...base, stock_status: 'in_stock', image_main_url: null }, { regular_price_vnd: 1000000, is_active: true })).rejects.toMatchObject({ code: 'IMAGE_REQUIRED' })
  })
})
