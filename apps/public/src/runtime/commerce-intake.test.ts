import { describe, expect, it, vi } from 'vitest'
import { commerceIntakeEnabled, handleCommerce, parseCommerceBody } from './commerce-intake'

const prod = { APP_ENV: 'production', PUBLIC_COMMERCE: 'on' } as unknown as NodeJS.ProcessEnv
const binding = { connectionString: 'postgres://test' }
const URL_ = 'https://www.dongphugia.vn/api/commerce/orders'
const orderBody = { customerName: 'Nguyen Van A', customerPhone: '0912345678', deliveryAddress: '12 Le Loi, Q1', items: [{ productId: 1, quantity: 2, price: 1, unitPrice: 1, discount: 999 }], expectedTotalVnd: 2000000, totalVnd: 1, discount: 99 }
const req = (body: unknown, headers: Record<string, string> = {}, path = 'orders') => new Request(`https://www.dongphugia.vn/api/commerce/${path}`, {
  method: 'POST', headers: { origin: 'https://www.dongphugia.vn', 'content-type': 'application/json', 'idempotency-key': 'key-12345678', 'cf-connecting-ip': '203.0.113.9', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
const db = (result: unknown) => { const query = vi.fn().mockResolvedValue({ rows: [{ result }] }); const end = vi.fn().mockResolvedValue(undefined); return { connect: vi.fn().mockResolvedValue({ query, end }), query, end } }

describe('commerce intake (#470 commerce v1)', () => {
  it('is closed unless PUBLIC_COMMERCE=on in Production or the isolated TEST Preview', async () => {
    for (const env of [{}, { APP_ENV: 'production' }, { APP_ENV: 'production', PUBLIC_COMMERCE: 'off' }, { APP_ENV: 'staging', PUBLIC_COMMERCE: 'on' }, { APP_ENV: 'preview', PREVIEW_TEST_DATABASE_ISOLATED: 'true', PUBLIC_COMMERCE: 'on' }])
      expect(commerceIntakeEnabled(env as never), JSON.stringify(env)).toBe(false)
    expect(commerceIntakeEnabled({ APP_ENV: 'staging', PREVIEW_TEST_DATABASE_ISOLATED: 'true', PUBLIC_COMMERCE: 'on' } as never)).toBe(true)
    expect((await handleCommerce('orders', req(orderBody), { env: { APP_ENV: 'production' } as never, binding })).status).toBe(404)
  })
  it('drops every client price/discount/total field and forwards only ids, quantities, contact and the total the customer saw', async () => {
    const d = db({ ok: true, kind: 'order', code: 'DH-0123456789', status: 'new', totalVnd: 2000000 })
    const result = await handleCommerce('orders', req(orderBody), { env: prod, binding, connect: d.connect })
    expect(result).toMatchObject({ status: 201, body: { ok: true, code: 'DH-0123456789' } })
    expect(d.query.mock.calls.map(([sql]) => String(sql).split('(')[0].trim())).toEqual(['BEGIN', 'SET LOCAL ROLE dpg_commerce_intake', 'SELECT dpg_commerce.order_submit', 'COMMIT'])
    const [, values] = d.query.mock.calls.find(([sql]) => String(sql).includes('order_submit'))!
    const sent = JSON.parse(values[0])
    expect(sent.items).toEqual([{ productId: 1, quantity: 2 }]); expect(sent).not.toHaveProperty('totalVnd'); expect(sent).not.toHaveProperty('discount'); expect(sent.expectedTotalVnd).toBe(2000000)
    expect(values[1]).toBe('key-12345678'); expect(values[2]).toMatch(/^[0-9a-f]{32}$/)           // IP is only ever a daily hash
    expect(JSON.stringify(d.query.mock.calls)).not.toContain('203.0.113.9')
    expect(d.end).toHaveBeenCalled()
  })
  it('a replayed receipt is 200, a new one 201; the cart check needs no idempotency key', async () => {
    expect((await handleCommerce('orders', req(orderBody), { env: prod, binding, connect: db({ ok: true, replayed: true, code: 'DH-1' }).connect })).status).toBe(200)
    const cart = await handleCommerce('cart', req({ items: [{ productId: 1, quantity: 1 }] }, { 'idempotency-key': '' }, 'cart'), { env: prod, binding, connect: db({ ok: true, lines: [] }).connect })
    expect(cart.status).toBe(200)
  })
  it.each([
    ['PRICE_CHANGED', 409], ['ITEMS_NOT_ORDERABLE', 409], ['PRODUCT_UNAVAILABLE', 409], ['RATE_LIMITED', 429], ['INVALID_CUSTOMER_PHONE', 400], ['IDEMPOTENCY_KEY_REUSED', 409], ['INVALID_QUANTITY', 400],
  ])('maps the database result %s to HTTP %i without echoing input', async (code, status) => {
    const result = await handleCommerce('orders', req(orderBody), { env: prod, binding, connect: db({ error: code, totalVnd: 123, secret: 'x' }).connect })
    expect(result).toMatchObject({ status, body: { ok: false, code } })
    expect(JSON.stringify(result.body)).not.toContain('secret')
  })
  it('PRICE_CHANGED carries the new server total so the customer can confirm; other errors carry nothing extra', async () => {
    const changed = await handleCommerce('orders', req(orderBody), { env: prod, binding, connect: db({ error: 'PRICE_CHANGED', totalVnd: 1900000, subtotalVnd: 2000000, voucherVnd: 100000 }).connect })
    expect(changed.body).toMatchObject({ code: 'PRICE_CHANGED', totalVnd: 1900000, voucherVnd: 100000 })
  })
  it('hides database failures (no SQL/driver text), rolls back, and still closes the connection', async () => {
    const calls: string[] = []; const end = vi.fn().mockResolvedValue(undefined)
    const connect = vi.fn().mockResolvedValue({ query: vi.fn(async (sql: string) => { calls.push(sql.split('(')[0].trim()); if (sql.startsWith('SELECT')) throw new Error('relation "dpg_commerce.orders" does not exist'); return { rows: [] } }), end })
    const result = await handleCommerce('orders', req(orderBody), { env: prod, binding, connect })
    expect(result).toMatchObject({ status: 500, body: { code: 'COMMERCE_FAILED' } }); expect(JSON.stringify(result)).not.toContain('relation')
    expect(calls).toEqual(['BEGIN', 'SET LOCAL ROLE dpg_commerce_intake', 'SELECT dpg_commerce.order_submit', 'ROLLBACK']); expect(end).toHaveBeenCalled()
  })
  it('validates and refuses BEFORE touching the database: origin, content type, idempotency key, size, JSON, item shape, contact types, expected total', async () => {
    const d = db({})
    const cases: [Request, number][] = [
      [req(orderBody, { origin: 'https://evil.example' }), 403],
      [new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key-12345678' }, body: JSON.stringify(orderBody) }), 403],   // no Origin, no same-origin fetch metadata
      [req(orderBody, { 'content-type': 'text/plain' }), 415],
      [req(orderBody, { 'idempotency-key': 'short' }), 400], [req('{'), 400], [req({ ...orderBody, items: [] }), 400],
      [req({ ...orderBody, items: [{ productId: 1, quantity: 0 }] }), 400], [req({ ...orderBody, items: [{ productId: 1, quantity: 100 }] }), 400], [req({ ...orderBody, items: [{ productId: '1', quantity: 1 }] }), 400],
      [req({ ...orderBody, items: Array.from({ length: 21 }, (_, i) => ({ productId: i + 1, quantity: 1 })) }), 400],
      [req({ ...orderBody, customerName: 5 }), 400], [req({ ...orderBody, expectedTotalVnd: 'abc' }), 400], [req({ ...orderBody, expectedTotalVnd: 0 }), 400], [req({ ...orderBody, expectedTotalVnd: undefined }), 400],
      [req('x'.repeat(20_000)), 413],
      [new Request(URL_, { method: 'GET' }), 405],
    ]
    for (const [request, status] of cases) expect((await handleCommerce('orders', request, { env: prod, binding, connect: d.connect })).status).toBe(status)
    expect(d.connect).not.toHaveBeenCalled()
    expect(parseCommerceBody('quotes', { items: [{ productId: 1, quantity: 1 }], customerName: 'A' })).toMatchObject({ ok: true })
    expect((await handleCommerce('orders', req(orderBody), { env: prod })).status).toBe(503)      // flag on but no intake binding: refused, never a silent fallback
  })
  it('a same-origin fetch without an Origin header is accepted via Sec-Fetch-Site', async () => {
    const request = new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'key-12345678', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(orderBody) })
    expect((await handleCommerce('orders', request, { env: prod, binding, connect: db({ ok: true, code: 'DH-1' }).connect })).status).toBe(201)
  })
})
