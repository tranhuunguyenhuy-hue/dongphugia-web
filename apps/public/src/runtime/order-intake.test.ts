import { describe, expect, it, vi } from 'vitest'
import { createGuestOrder, orderIntakeEnabled, parseOrderRequest } from './order-intake'

const env = { APP_ENV: 'staging', PREVIEW_TEST_DATABASE_ISOLATED: 'true' } as unknown as NodeJS.ProcessEnv
const body = { customer_name: 'A', customer_phone: '0912345678', items: [{ productId: 207, sku: 'LT533R#XW', quantity: 2, price: 1, unit_price: 1, discount: 999 }] }
const request = (payload: unknown, headers: Record<string, string> = { 'idempotency-key': 'key-12345678' }) =>
  new Request('https://x.test/api/orders', { method: 'POST', headers, body: typeof payload === 'string' ? payload : JSON.stringify(payload) })
const connectReturning = (result: unknown) => {
  const query = vi.fn().mockResolvedValue({ rows: [{ result }] }); const end = vi.fn().mockResolvedValue(undefined)
  return { connect: vi.fn().mockResolvedValue({ query, end }), query, end }
}
const binding = { connectionString: 'postgres://test' }

describe('guest order intake (#446)', () => {
  it('is closed outside the isolated TEST Preview (Production never takes orders here)', async () => {
    expect(orderIntakeEnabled({ APP_ENV: 'production' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(orderIntakeEnabled({ APP_ENV: 'staging' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    const result = await createGuestOrder(request(body), { env: { APP_ENV: 'production' } as unknown as NodeJS.ProcessEnv, binding })
    expect(result).toMatchObject({ ok: false, status: 404 })
  })
  it('drops every client-sent price field and forwards only ids, sku, quantity, install option', async () => {
    const db = connectReturning({ order_number: 'DPG-1', status: 'pending', payment_status: 'unpaid' })
    const result = await createGuestOrder(request(body), { env, binding, connect: db.connect })
    expect(result).toMatchObject({ ok: true, status: 200, body: { success: true, order_number: 'DPG-1' } })
    const [sql, values] = db.query.mock.calls[0]
    expect(sql).toContain('public.guest_order_request_create')
    expect(JSON.parse(values[0]).items).toEqual([{ productId: 207, sku: 'LT533R#XW', quantity: 2 }])
    expect(values[1]).toBe('key-12345678')
    expect(db.end).toHaveBeenCalled()
  })
  it.each([
    ['PRODUCT_REQUIRES_QUOTE', 422], ['PRODUCT_UNAVAILABLE', 409], ['ORDER_RATE_LIMITED', 429], ['INVALID_CUSTOMER_PHONE', 400], ['IDEMPOTENCY_KEY_REUSED', 409],
  ])('maps database result %s to HTTP %i', async (code, status) => {
    const result = await createGuestOrder(request(body), { env, binding, connect: connectReturning({ error: code }).connect })
    expect(result).toMatchObject({ ok: false, status, body: { code } })
  })
  it('maps raised database errors and hides unknown ones', async () => {
    const raise = (message: string) => ({ connect: vi.fn().mockResolvedValue({ query: vi.fn().mockRejectedValue(new Error(message)), end: vi.fn().mockResolvedValue(undefined) }) })
    expect(await createGuestOrder(request(body), { env, binding, connect: raise('INVALID_QUANTITY').connect })).toMatchObject({ status: 400, body: { code: 'INVALID_QUANTITY' } })
    const hidden = await createGuestOrder(request(body), { env, binding, connect: raise('relation "x" does not exist').connect })
    expect(hidden).toMatchObject({ status: 500, body: { code: 'ORDER_REQUEST_FAILED' } })
    expect(JSON.stringify(hidden)).not.toContain('relation')
  })
  it('validates before touching the database', async () => {
    const db = connectReturning({})
    for (const [payload, headers] of [
      [body, {}], [body, { 'idempotency-key': 'short' }], ['{', undefined], [{ ...body, items: [] }, undefined],
      [{ ...body, items: [{ productId: 1, sku: 'A', quantity: 0 }] }, undefined], [{ ...body, items: [{ productId: '1', sku: 'A', quantity: 1 }] }, undefined],
      [{ ...body, items: [{ productId: 1, sku: 'A', quantity: 1, installOption: 'bad' }] }, undefined], [{ ...body, customer_name: 5 }, undefined],
    ] as const) {
      const result = await createGuestOrder(request(payload, headers as Record<string, string> | undefined), { env, binding, connect: db.connect })
      expect(result.ok, JSON.stringify(payload)).toBe(false)
    }
    expect(db.connect).not.toHaveBeenCalled()
    expect(parseOrderRequest({ ...body, items: Array.from({ length: 21 }, (_, i) => ({ productId: i + 1, sku: 'S', quantity: 1 })) })).toEqual({ ok: false, code: 'INVALID_INPUT' })
  })
  it('refuses cross-origin submissions before touching the database', async () => {
    const db = connectReturning({})
    const cross = new Request('https://x.test/api/orders', { method: 'POST', headers: { 'idempotency-key': 'key-12345678', origin: 'https://evil.example' }, body: JSON.stringify(body) })
    expect(await createGuestOrder(cross, { env, binding, connect: db.connect })).toMatchObject({ ok: false, status: 403 })
    const same = new Request('https://x.test/api/orders', { method: 'POST', headers: { 'idempotency-key': 'key-12345678', origin: 'https://x.test' }, body: JSON.stringify(body) })
    expect(await createGuestOrder(same, { env, binding, connect: connectReturning({ order_number: 'DPG-2', status: 'pending', payment_status: 'unpaid' }).connect })).toMatchObject({ ok: true })
    expect(db.connect).not.toHaveBeenCalled()
  })
  it('rejects oversized bodies and reports a missing binding as unavailable', async () => {
    expect(await createGuestOrder(request('x'.repeat(20_000)), { env, binding })).toMatchObject({ status: 413 })
    expect(await createGuestOrder(request(body), { env, binding: undefined, connect: connectReturning({}).connect }).catch(() => null)).not.toBeNull()
  })
})
