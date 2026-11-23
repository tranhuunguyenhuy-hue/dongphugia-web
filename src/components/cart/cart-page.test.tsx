import { webcrypto } from 'node:crypto'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCartStore } from '@/lib/cart-store'
import { CartPage } from './cart-page'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/tracking', () => ({ trackAddToCart: vi.fn(), trackPurchase: vi.fn() }))
// Fixed return values from the #453 contract. Production cart pricing is provided by Claude.
const applyOnlineVoucher = vi.fn<import('@/lib/cart-store').ApplyOnlineVoucher>(() => ({
    unitPriceBefore: 900_000, voucherPerUnit: 50_000, finalUnitPrice: 850_000,
}))

const product = {
    productId: 207, sku: 'LT533R#XW', name: 'Chậu rửa', slug: 'chau-rua',
    categorySlug: 'thiet-bi-ve-sinh', price: 900_000, priceDisplay: null, imageUrl: null,
    canonicalVoucher: { amount: 50_000, applyOnlineVoucher },
}

beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    useCartStore.setState({ items: [], isOpen: false })
    vi.stubGlobal('crypto', webcrypto)
    applyOnlineVoucher.mockClear()
})
afterEach(() => vi.unstubAllGlobals())

describe('isolated checkout', () => {
    it('prices once per line across repeat adds, quantity edits and local reload', async () => {
        const cart = useCartStore.getState()
        expect(cart.addItem({ ...product, price: null })).toBe(false)
        expect(cart.addItem(product)).toBe(true)
        expect(cart.addItem(product)).toBe(true)
        let [line] = useCartStore.getState().items
        expect(line).toMatchObject({ unitPriceBefore: 900_000, voucherPerUnit: 50_000, finalUnitPrice: 850_000, quantity: 2 })
        cart.updateQuantity(line.cartItemId, 3)
        await useCartStore.persist.rehydrate()
        ;[line] = useCartStore.getState().items
        expect(line.finalUnitPrice * line.quantity).toBe(2_550_000)
        expect(applyOnlineVoucher).toHaveBeenCalledExactlyOnceWith({
            unitPrice: 900_000, voucherAmount: 50_000, quantity: 1,
        })
    })

    it('retains the cart after an error and reuses the request key for the same order', async () => {
        useCartStore.getState().addItem({ ...product, quantity: 2 })
        const fetchOrders = vi.fn()
            .mockResolvedValueOnce(Response.json({ success: false, error: 'Vui lòng thử lại.', code: 'ORDER_REQUEST_FAILED' }, { status: 500 }))
            .mockResolvedValueOnce(Response.json({ success: true, order_number: 'DPG-TEST', order_status: 'pending', payment_status: 'unpaid' }))
        vi.stubGlobal('fetch', fetchOrders)
        render(<CartPage isolatedCheckout />)

        expect(screen.getByText(/Voucher đã trừ −100\.000/)).toBeInTheDocument()
        expect(screen.getAllByText(/1\.700\.000/)).toHaveLength(3)
        fireEvent.change(screen.getByLabelText(/Họ và tên/), { target: { value: 'Khách thử' } })
        fireEvent.change(screen.getByLabelText(/Số điện thoại/), { target: { value: '+84 912 345 678' } })
        const submit = screen.getByRole('button', { name: 'Xác nhận đặt hàng' })
        fireEvent.click(submit)
        expect(await screen.findByText('Vui lòng thử lại.')).toBeInTheDocument()
        expect(useCartStore.getState().items).toHaveLength(1)
        fireEvent.click(submit)

        expect(await screen.findByText('DPG-TEST')).toBeInTheDocument()
        await waitFor(() => expect(useCartStore.getState().items).toHaveLength(0))
        const [[path, first], [, retry]] = fetchOrders.mock.calls
        expect(path).toBe('/api/orders')
        expect(first.headers['Idempotency-Key']).toMatch(/^[A-Za-z0-9._:-]{8,200}$/)
        expect(retry).toEqual(first)
        expect(JSON.parse(first.body)).toEqual({
            customer_name: 'Khách thử', customer_phone: '+84912345678',
            customer_email: '', customer_address: '', note: '',
            items: [{ productId: 207, sku: 'LT533R#XW', quantity: 2, installOption: 'none' }],
        })
    })

    it('blocks persisted sanitary lines with legacy pricing until they are re-added', () => {
        const { canonicalVoucher: _voucher, ...legacyProduct } = product
        useCartStore.getState().addItem(legacyProduct)
        render(<CartPage isolatedCheckout />)
        expect(screen.getByRole('button', { name: 'Xác nhận đặt hàng' })).toBeDisabled()
        expect(screen.getByText('Cần cập nhật giá')).toBeInTheDocument()
        act(() => { useCartStore.getState().addItem(product) })
        expect(screen.getByRole('button', { name: 'Xác nhận đặt hàng' })).toBeEnabled()
    })
})
