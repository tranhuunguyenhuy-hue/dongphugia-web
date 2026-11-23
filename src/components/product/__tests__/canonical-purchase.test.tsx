import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCartStore } from '@/lib/cart-store'
import { ProductPurchasePanel } from '../product-purchase-panel'

vi.mock('@/components/product/product-cta', () => ({ ProductCTA: () => <span>Existing CTA</span> }))
vi.mock('@/lib/tracking', () => ({ trackAddToCart: vi.fn() }))

const product = {
    id: 207, sku: 'LT533R#XW', slug: 'chau-rua', name: 'Chậu rửa',
    price: 4_000_000, original_price: 5_000_000,
    list_price: 1_000_000, sale_price: 900_000, online_discount_amount: 50_000, price_display: null,
    image_main_url: null, product_images: [],
    stock_status: 'contact', is_active: true, variant_group: null, variant_type: null, variant_label: null,
    colors: null, brands: null,
}
const categorySlug = 'thiet-bi-ve-sinh'

beforeEach(() => useCartStore.setState({ items: [], isOpen: false }))

describe('Hita PDP', () => {
    it('displays the exact SKU offer and applies its voucher on adding to the cart', () => {
        render(<ProductPurchasePanel product={product} categorySlug={categorySlug} canonicalPricing />)
        expect(screen.getByText(/900\.000/)).toBeInTheDocument()
        expect(screen.getByText(/1\.000\.000/)).toBeInTheDocument()
        expect(screen.getByText('50.000đ')).toBeInTheDocument()
        expect(screen.queryByText(/850\.000|4\.000\.000|5\.000\.000/)).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Thêm vào giỏ hàng' }))
        expect(useCartStore.getState().items).toMatchObject([{ sku: product.sku, finalUnitPrice: 850_000 }])
    })

    it.each([
        { sku: 'LT700CTR#W', list_price: null, sale_price: null, online_discount_amount: null },
        { sku: 'TVLM105CR', stock_status: 'discontinued', list_price: null, sale_price: null },
    ])('keeps unavailable and missing-price SKUs quote-only (%j)', overrides => {
        render(<ProductPurchasePanel product={{ ...product, ...overrides }} categorySlug={categorySlug} canonicalPricing />)
        expect(screen.getByText('Liên hệ báo giá')).toBeInTheDocument()
        expect(screen.queryByText('Voucher đặt online')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Thêm vào giỏ hàng' })).not.toBeInTheDocument()
    })
})
