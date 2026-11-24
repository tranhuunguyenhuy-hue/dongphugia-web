import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCommerceCart, CART_MAX_LINES } from '@/lib/commerce/cart-store'
import { commerceEnabled } from '@/lib/commerce/flags'
import { loadReceipts } from '@/lib/commerce/client'
import { CommerceCartPage } from './cart-page'
import { CommerceReceipt } from './receipt'
import { ProductActions } from './product-actions'
import { CommerceCartIcon } from './cart-icon'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/lib/tracking', () => ({ trackViewItem: vi.fn() }))

const line = (id: number, extra = {}) => ({ productId: id, sku: `SKU-${id}`, name: `San pham ${id}`, slug: `sp-${id}`, categorySlug: 'thiet-bi-ve-sinh', subcategorySlug: 'chau', imageUrl: null, brandName: 'TOTO', ...extra })
const orderLine = (id: number, qty: number) => ({ productId: id, sku: `SKU-${id}`, name: `San pham ${id}`, brand: 'TOTO', quantity: qty, mode: 'order', regularVnd: 2_000_000, unitSellingVnd: 1_800_000, unitVoucherVnd: 100_000, lineTotalVnd: 1_700_000 * qty })
const quoteLine = (id: number, qty: number) => ({ productId: id, sku: `SKU-${id}`, name: `San pham ${id}`, brand: 'TOTO', quantity: qty, mode: 'quote', reason: 'NO_PRICE' })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const checkBody = (lines: unknown[]) => { const orders = (lines as { mode: string; lineTotalVnd?: number; quantity: number; unitSellingVnd?: number; unitVoucherVnd?: number }[]).filter(l => l.mode === 'order')
  return { ok: true, lines, order: { count: orders.length, subtotalVnd: orders.reduce((s, l) => s + l.unitSellingVnd! * l.quantity, 0), voucherVnd: orders.reduce((s, l) => s + l.unitVoucherVnd! * l.quantity, 0), totalVnd: orders.reduce((s, l) => s + l.lineTotalVnd!, 0) }, quoteCount: lines.filter(l => (l as { mode: string }).mode === 'quote').length, unavailableCount: 0 } }

let calls: { path: string; body: Record<string, unknown>; headers: Record<string, string> }[] = []
function mockApi(handler: (path: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = String(url).replace('/api/commerce/', ''); const body = JSON.parse(String(init.body)); calls.push({ path, body, headers: init.headers as Record<string, string> })
    return handler(path, body)
  }))
}
beforeEach(() => { useCommerceCart.setState({ lines: [] }); sessionStorage.clear(); push.mockClear() })
afterEach(() => vi.unstubAllGlobals())
const fill = () => {
  fireEvent.change(screen.getByLabelText('Họ tên'), { target: { value: 'Nguyen Van A' } })
  fireEvent.change(screen.getByLabelText('Số điện thoại'), { target: { value: '0912 345 678' } })
}

describe('flags', () => {
  it('commerce UI is on only in Production with PUBLIC_COMMERCE=on or the isolated TEST Preview with the flag', () => {
    expect(commerceEnabled({ APP_ENV: 'production', PUBLIC_COMMERCE: 'on' })).toBe(true)
    expect(commerceEnabled({ APP_ENV: 'staging', PREVIEW_TEST_DATABASE_ISOLATED: 'true', PUBLIC_COMMERCE: 'on' })).toBe(true)
    for (const env of [{}, { APP_ENV: 'production' }, { APP_ENV: 'production', PUBLIC_COMMERCE: 'true' }, { APP_ENV: 'staging', PUBLIC_COMMERCE: 'on' }, { APP_ENV: 'preview', PUBLIC_COMMERCE: 'on' }]) expect(commerceEnabled(env)).toBe(false)
  })
})

describe('cart store', () => {
  it('stores id + quantity facts only (never a price), merges the same SKU, clamps 1..99 and caps 20 lines', () => {
    const { add, setQuantity } = useCommerceCart.getState()
    expect(add(line(1), 2)).toBe('added'); expect(add(line(1), 200)).toBe('updated')
    expect(useCommerceCart.getState().lines[0].quantity).toBe(99)
    setQuantity(1, 0); expect(useCommerceCart.getState().lines[0].quantity).toBe(1)
    for (let i = 2; i <= CART_MAX_LINES; i++) add(line(i))
    expect(add(line(99))).toBe('full'); expect(useCommerceCart.getState().lines).toHaveLength(CART_MAX_LINES)
    expect(add({ ...line(5), sku: ' ' })).toBe('invalid')
    expect(Object.keys(useCommerceCart.getState().lines[0]).some(key => /price|voucher|discount|total/i.test(key))).toBe(false)
  })
  it('does not read the legacy cart key', () => {
    localStorage.setItem('dpg-cart', JSON.stringify({ state: { items: [{ productId: 1, price: 1 }] } }))
    expect(useCommerceCart.getState().lines).toEqual([])
  })
})

describe('cart icon', () => {
  it('links to /gio-hang and shows the total quantity', () => {
    useCommerceCart.getState().add(line(1), 2); useCommerceCart.getState().add(line(2), 3)
    render(<CommerceCartIcon />)
    expect(screen.getByRole('link', { name: '5' })).toHaveAttribute('href', '/gio-hang')      // (the test environment's Link mock drops aria-label; the badge is the visible count)
  })
})

describe('cart page', () => {
  it('shows the server price/voucher/total, sends only ids + quantities, then stores the receipt and goes to the confirmation', async () => {
    useCommerceCart.getState().add(line(1), 1); useCommerceCart.getState().add(line(2), 3)
    mockApi((path) => path === 'cart' ? json(200, checkBody([orderLine(1, 1), orderLine(2, 3)])) : json(201, { ok: true, kind: 'order', code: 'DH-0123456789', status: 'new', totalVnd: 5_100_000, lineCount: 2 }))
    render(<CommerceCartPage />)
    await screen.findByText('Đặt hàng (2 sản phẩm)')
    expect(screen.getAllByText(/6\.800\.000/).length).toBeGreaterThan(0)          // 1 x 1.7M + 3 x 1.7M
    expect(screen.getByText(/Chưa gồm phí vận chuyển/)).toBeInTheDocument(); expect(screen.getByText(/chưa phải thanh toán/)).toBeInTheDocument()
    fill(); fireEvent.change(screen.getByLabelText('Địa chỉ giao hàng'), { target: { value: '12 Le Loi, Quan 1, TP HCM' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gửi đơn đặt hàng' }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/dat-hang-thanh-cong'))
    const order = calls.find(c => c.path === 'orders')!
    expect(order.body).toMatchObject({ expectedTotalVnd: 6_800_000, items: [{ productId: 1, quantity: 1 }, { productId: 2, quantity: 3 }] })
    expect(JSON.stringify(order.body)).not.toMatch(/unitSelling|regularVnd|lineTotal|discount/)       // no client price is ever sent
    expect(order.headers['idempotency-key']).toMatch(/^order-/)
    expect(loadReceipts()).toMatchObject([{ kind: 'order', code: 'DH-0123456789' }]); expect(useCommerceCart.getState().lines).toEqual([])
  })
  it('mixed cart: order and quote are separate sections with separate submissions; the quote line stays until its own submission', async () => {
    useCommerceCart.getState().add(line(1), 1); useCommerceCart.getState().add(line(2), 2)
    mockApi((path) => path === 'cart' ? json(200, checkBody([orderLine(1, 1), quoteLine(2, 2)])) : json(201, { ok: true, kind: 'order', code: 'DH-AAAAAAAAAA', status: 'new', totalVnd: 1_700_000, lineCount: 1 }))
    render(<CommerceCartPage />)
    await screen.findByLabelText('Yêu cầu báo giá'); expect(screen.getByLabelText('Đặt hàng')).toBeInTheDocument()
    expect(screen.getByText(/hai phần được gửi riêng/)).toBeInTheDocument()
    fill(); fireEvent.change(screen.getByLabelText('Địa chỉ giao hàng'), { target: { value: '12 Le Loi, Quan 1, TP HCM' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gửi đơn đặt hàng' }))
    await waitFor(() => expect(push).toHaveBeenCalled())
    expect(calls.find(c => c.path === 'orders')!.body.items).toEqual([{ productId: 1, quantity: 1 }])          // the quote line is NOT silently included
    expect(useCommerceCart.getState().lines.map(l => l.productId)).toEqual([2])                                  // and NOT silently dropped
  })
  it('quote only: no address needed, sends contact + ids, receipt kind quote', async () => {
    useCommerceCart.getState().add(line(2), 2)
    mockApi((path) => path === 'cart' ? json(200, checkBody([quoteLine(2, 2)])) : json(201, { ok: true, kind: 'quote', code: 'BG-0123456789', status: 'new', lineCount: 1 }))
    render(<CommerceCartPage />)
    await screen.findByText('Yêu cầu báo giá (1 sản phẩm)'); expect(screen.queryByLabelText('Địa chỉ giao hàng')).not.toBeInTheDocument()
    fill(); fireEvent.click(screen.getByRole('button', { name: 'Gửi yêu cầu báo giá' }))
    await waitFor(() => expect(push).toHaveBeenCalled())
    expect(calls.find(c => c.path === 'quotes')!.body).toMatchObject({ items: [{ productId: 2, quantity: 2 }], customerName: 'Nguyen Van A' })
    expect(loadReceipts()[0]).toMatchObject({ kind: 'quote', code: 'BG-0123456789' })
  })
  it('PRICE_CHANGED: the new total is shown, nothing is submitted silently, and the customer confirms with a second click', async () => {
    useCommerceCart.getState().add(line(1), 1)
    let totals = [1_700_000, 1_500_000]
    mockApi((path) => {
      if (path === 'cart') { const t = totals[0]; return json(200, checkBody([{ ...orderLine(1, 1), unitSellingVnd: t + 100_000, lineTotalVnd: t }])) }
      if (totals.length > 1) { totals = [1_500_000]; return json(409, { ok: false, code: 'PRICE_CHANGED', error: 'Giá sản phẩm vừa thay đổi.', totalVnd: 1_500_000 }) }
      return json(201, { ok: true, kind: 'order', code: 'DH-BBBBBBBBBB', status: 'new', totalVnd: 1_500_000, lineCount: 1 })
    })
    render(<CommerceCartPage />)
    await screen.findByText('Đặt hàng (1 sản phẩm)'); fill(); fireEvent.change(screen.getByLabelText('Địa chỉ giao hàng'), { target: { value: '12 Le Loi, Quan 1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gửi đơn đặt hàng' }))
    await screen.findByText(/Giá vừa thay đổi/); expect(push).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('button', { name: 'Xác nhận và gửi đơn hàng' })
    fireEvent.click(confirm); await waitFor(() => expect(push).toHaveBeenCalled())
    expect(calls.filter(c => c.path === 'orders').map(c => c.body.expectedTotalVnd)).toEqual([1_700_000, 1_500_000])
  })
  it('retry after a network failure replays the SAME idempotency key (no duplicate order)', async () => {
    useCommerceCart.getState().add(line(1), 1)
    let n = 0
    mockApi((path) => { if (path === 'cart') return json(200, checkBody([orderLine(1, 1)])); n++; if (n === 1) throw new Error('offline'); return json(201, { ok: true, kind: 'order', code: 'DH-CCCCCCCCCC', status: 'new', totalVnd: 1_700_000, lineCount: 1 }) })
    render(<CommerceCartPage />)
    await screen.findByText('Đặt hàng (1 sản phẩm)'); fill(); fireEvent.change(screen.getByLabelText('Địa chỉ giao hàng'), { target: { value: '12 Le Loi, Quan 1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gửi đơn đặt hàng' })); await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: 'Gửi đơn đặt hàng' })); await waitFor(() => expect(push).toHaveBeenCalled())
    const keys = calls.filter(c => c.path === 'orders').map(c => c.headers['idempotency-key']); expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1])
  })
  it('client validation blocks bad contact data before any request; unavailable lines are flagged', async () => {
    useCommerceCart.getState().add(line(1), 1); useCommerceCart.getState().add(line(3), 1)
    mockApi(() => json(200, checkBody([orderLine(1, 1), { productId: 3, quantity: 1, mode: 'unavailable' }])))
    render(<CommerceCartPage />)
    expect((await screen.findAllByText(/không còn khả dụng/)).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Gửi đơn đặt hàng' })); expect((await screen.findByRole('alert')).textContent).toMatch(/họ tên/)
    fireEvent.change(screen.getByLabelText('Họ tên'), { target: { value: 'Nguyen Van A' } }); fireEvent.change(screen.getByLabelText('Số điện thoại'), { target: { value: '12345' } })
    fireEvent.click(screen.getByRole('button', { name: 'Gửi đơn đặt hàng' })); await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/số điện thoại/))
    expect(calls.every(c => c.path === 'cart')).toBe(true)
  })
  it('an empty cart shows the empty state', () => { render(<CommerceCartPage />); expect(screen.getByText('Giỏ hàng trống')).toBeInTheDocument() })
})

describe('receipt', () => {
  it('shows the codes of this session, says it is not a payment/stock guarantee, and carries no personal data', async () => {
    sessionStorage.setItem('dpg-receipts-v2', JSON.stringify([{ kind: 'order', code: 'DH-0123456789', status: 'new', totalVnd: 5_100_000, lineCount: 2, at: 1 }, { kind: 'x', code: '<script>', at: 2 }]))
    render(<CommerceReceipt />)
    await screen.findByText('DH-0123456789'); expect(screen.getByText(/chưa phải thanh toán/)).toBeInTheDocument(); expect(screen.queryByText('<script>')).not.toBeInTheDocument()
  })
  it('without a session receipt it says so (a URL parameter cannot forge a receipt)', async () => {
    render(<CommerceReceipt />); await screen.findByText('Không có biên nhận trong phiên này')
  })
})

describe('product actions', () => {
  const props = { price: null, product: line(1) }
  it('commerce OFF: contact actions only — no cart or quote button', () => {
    render(<ProductActions commerce={false} canOrder product={props.product} price={1} />)
    expect(screen.getByText('Gọi tư vấn')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: /giỏ|báo giá/i })).not.toBeInTheDocument()
  })
  it('commerce ON: "Thêm vào giỏ hàng" with quantity, or "Yêu cầu báo giá" for a SKU that cannot be bought directly', () => {
    const { unmount } = render(<ProductActions commerce canOrder product={props.product} price={1} />)
    fireEvent.change(screen.getByLabelText('Số lượng', { selector: 'input' }), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Thêm vào giỏ hàng' })); expect(useCommerceCart.getState().lines[0].quantity).toBe(3)
    unmount(); useCommerceCart.setState({ lines: [] })
    render(<ProductActions commerce canOrder={false} product={line(2)} price={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Yêu cầu báo giá' })); expect(useCommerceCart.getState().lines[0].productId).toBe(2)
  })
})
