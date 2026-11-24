import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, commerce, type SalesDetail, type User } from './api'
import { ConfirmProvider, Toaster } from './ui'
import { SalesDetailPage, SalesList } from './Sales'
import { DashboardPage } from './Dashboard'

const user = (role: User['role'], permissions: string[]): User => ({ id: 1, email: 'a@example.test', name: 'A', role, permissions })
const admin = user('admin', ['*']), sale = user('sale', ['orders:read_assigned', 'orders:update_status', 'orders:edit_note'])
const order = (over: Partial<SalesDetail> = {}): SalesDetail => ({
  id: 5, code: 'DH-0123456789', status: 'new', customer_name: 'Nguyen Van A', customer_phone: '0912345678', customer_email: null, note: 'Giao sang', staff_note: null, version: 1, delivery_address: '12 Le Loi, Q1', subtotal_vnd: 6_400_000, voucher_vnd: 300_000, total_vnd: 6_100_000,
  line_count: 2, assigned_to: null, assigned_name: null, created_at: '2026-11-24T01:00:00Z', updated_at: '2026-11-24T01:00:00Z',
  lines: [{ line_no: 1, product_id: 1, sku: 'T-1', product_name: 'TOTO 1', brand: 'TOTO', quantity: 1, regular_vnd: 1_000_000, unit_selling_vnd: 1_000_000, unit_voucher_vnd: 0, line_subtotal_vnd: 1_000_000, line_voucher_vnd: 0 },
    { line_no: 2, product_id: 2, sku: 'T-2', product_name: 'TOTO 2', brand: 'TOTO', quantity: 3, regular_vnd: 2_000_000, unit_selling_vnd: 1_800_000, unit_voucher_vnd: 100_000, line_subtotal_vnd: 5_400_000, line_voucher_vnd: 300_000 }],
  events: [{ actor: 'guest', action: 'created', from_status: null, to_status: 'new', at: '2026-11-24T01:00:00Z' }], ...over })
const page = (u: User, kind: 'orders' | 'quotes' = 'orders') => render(<ConfirmProvider><SalesDetailPage kind={kind} id={5} user={u} go={vi.fn()} /><Toaster /></ConfirmProvider>)
beforeEach(() => { vi.spyOn(commerce, 'assignees').mockResolvedValue([{ id: 2, name: 'Sale 1', role: 'sale' }]) })
afterEach(() => vi.restoreAllMocks())

describe('commerce v1 inbox (Admin SPA)', () => {
  it('shows the exact snapshot (prices, voucher once, total) and never offers a "paid" action', async () => {
    vi.spyOn(commerce, 'get').mockResolvedValue(order())
    page(admin)
    await screen.findByText(/DH-0123456789/)
    expect(screen.getAllByText(/6\.100\.000/).length).toBeGreaterThan(0); expect(screen.getByText(/−300\.000/ ,{ selector: 'dd' })).toBeInTheDocument()
    expect(screen.getByText(/chưa gồm phí vận chuyển/)).toBeInTheDocument(); expect(screen.getByText(/không ghi nhận thanh toán/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /thanh toán|đã trả|paid/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bắt đầu xử lý' })).toBeInTheDocument()
  })
  it('moves the status with the version it loaded (optimistic lock)', async () => {
    vi.spyOn(commerce, 'get').mockResolvedValueOnce(order({ version: 4 })).mockResolvedValue(order({ status: 'processing', version: 5 }))
    // the real API answers a write with the changed row ONLY (no lines/events): the page must not crash on it and must re-read the detail
    const { lines: _l, events: _e, ...partial } = order({ status: 'processing', version: 5 })
    const set = vi.spyOn(commerce, 'setStatus').mockResolvedValue(partial as unknown as SalesDetail)
    page(admin)
    fireEvent.click(await screen.findByRole('button', { name: 'Bắt đầu xử lý' }))
    await waitFor(() => expect(set).toHaveBeenCalledWith('orders', 5, 'processing', 4, undefined))
    expect(await screen.findByRole('button', { name: 'Hoàn tất' })).toBeInTheDocument()
    expect(screen.getByText('TOTO 2')).toBeInTheDocument()          // lines + history still rendered after the action
  })
  it('saving the internal note keeps the page alive (regression: partial write response crashed the detail)', async () => {
    vi.spyOn(commerce, 'get').mockResolvedValueOnce(order({ version: 2 })).mockResolvedValue(order({ version: 3, staff_note: 'Da goi khach' }))
    const { lines: _l, events: _e, ...partial } = order({ version: 3, staff_note: 'Da goi khach' })
    const save = vi.spyOn(commerce, 'setNote').mockResolvedValue(partial as unknown as SalesDetail)
    page(admin)
    fireEvent.change(await screen.findByLabelText('Ghi chú nội bộ'), { target: { value: 'Da goi khach' } })
    fireEvent.click(screen.getByRole('button', { name: 'Lưu ghi chú' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith('orders', 5, 'Da goi khach', 2))
    expect(await screen.findByText('TOTO 2')).toBeInTheDocument(); expect(screen.getByLabelText('Ghi chú nội bộ')).toHaveValue('Da goi khach')
  })
  it('a sale user (no orders:cancel) never sees the cancel button; terminal states offer no action', async () => {
    vi.spyOn(commerce, 'get').mockResolvedValue(order())
    const { unmount } = page(sale); await screen.findByText(/DH-0123456789/)
    expect(screen.getByRole('button', { name: 'Bắt đầu xử lý' })).toBeInTheDocument(); expect(screen.queryByRole('button', { name: 'Huỷ' })).not.toBeInTheDocument(); expect(screen.queryByLabelText('Giao cho')).not.toBeInTheDocument()
    unmount(); vi.spyOn(commerce, 'get').mockResolvedValue(order({ status: 'done' }))
    page(admin); await screen.findByText(/Trạng thái cuối/)
  })
  it('a stale version reloads the record and says so (no silent overwrite)', async () => {
    const get = vi.spyOn(commerce, 'get').mockResolvedValue(order())
    vi.spyOn(commerce, 'setStatus').mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT'))
    page(admin); fireEvent.click(await screen.findByRole('button', { name: 'Bắt đầu xử lý' }))
    await screen.findByText(/vừa được người khác cập nhật/); await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  })
  it('quotes show the reason and a NULL reference price as "—", never 0', async () => {
    vi.spyOn(commerce, 'get').mockResolvedValue({ ...order(), code: 'BG-0123456789', lines: [{ line_no: 1, product_id: 3, sku: 'N-1', product_name: 'No price', brand: null, quantity: 2, reason: 'NO_PRICE', unit_selling_vnd: null }] })
    page(admin, 'quotes'); await screen.findByText(/BG-0123456789/)
    expect(screen.getByText('Chưa có giá bán trực tuyến')).toBeInTheDocument(); expect(screen.getByText('—', { selector: 'td' })).toBeInTheDocument()
  })
  it('the list shows counts per status and links to the detail', async () => {
    vi.spyOn(commerce, 'list').mockResolvedValue({ items: [{ id: 5, code: 'DH-0123456789', status: 'new', customer_name: 'Nguyen Van A', customer_phone: '0912345678', total_vnd: 6_100_000, line_count: 2, assigned_to: null, created_at: '2026-11-24T01:00:00Z', updated_at: '2026-11-24T01:00:00Z' }], total: 1, counts: { new: 1, processing: 2, done: 3, cancelled: 4 } })
    render(<SalesList kind="orders" user={admin} go={vi.fn()} />)
    await screen.findByText('DH-0123456789'); expect(screen.getByText('Đang xử lý (2)')).toBeInTheDocument(); expect(screen.getByText('Tất cả (10)')).toBeInTheDocument()
  })
  it('dashboard for a sale user (scope own): own work only, no catalogue size; admin still sees it', async () => {
    const base = { new_orders: [], new_quotes: [] }
    const spy = vi.spyOn(commerce, 'dashboard').mockResolvedValueOnce({ scope: 'own', stats: { new_orders: 1, new_quotes: 0, processing_orders: 0, processing_quotes: 0, total_products: null, active_products: null }, ...base })
    const { unmount } = render(<DashboardPage go={vi.fn()} />)
    expect(await screen.findByText(/được giao cho bạn/)).toBeInTheDocument()
    expect(screen.queryByText('Sản phẩm đang bán')).not.toBeInTheDocument(); expect(screen.getByText('Đơn hàng mới')).toBeInTheDocument()
    unmount(); spy.mockResolvedValueOnce({ scope: 'all', stats: { new_orders: 3, new_quotes: 1, processing_orders: 0, processing_quotes: 0, total_products: 138, active_products: 134 }, ...base })
    render(<DashboardPage go={vi.fn()} />)
    expect(await screen.findByText('Sản phẩm đang bán')).toBeInTheDocument()
  })
})
