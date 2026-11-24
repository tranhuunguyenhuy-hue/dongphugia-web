import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCartStore } from '@/lib/cart-store'
import { ProductPurchasePanel } from '../product-purchase-panel'
import { ProductCard } from '@/components/ui/product-card'
import { buildProductSchema } from '@/lib/seo/schema'

vi.mock('@/components/product/product-cta', () => ({ ProductCTA: () => <span>Existing CTA</span> }))
vi.mock('@/lib/tracking', () => ({ trackAddToCart: vi.fn() }))

// #470 Architecture A: Production snapshot rows carry provenance 'hita-exact-v1'. Cart/checkout stay OFF; voucher is separate.
const priced = {
    id: 1, sku: 'LT533R#XW', slug: 'chau-rua', name: 'Chậu rửa', display_name: 'Chậu rửa',
    price: 900_000, original_price: 1_000_000, list_price: 1_000_000, sale_price: 900_000,
    online_discount_amount: 50_000, final_online_price: 850_000, price_display: null, is_promotion: true,
    price_provenance: 'hita-exact-v1', image_main_url: null, product_images: [],
    stock_status: 'contact', is_active: true, variant_group: null, variant_type: null, variant_label: null, colors: null, brands: null,
}
const unverified = { ...priced, price: null, original_price: null, list_price: null, sale_price: null, online_discount_amount: null,
    final_online_price: null, is_promotion: false, price_display: 'Cần liên hệ xác nhận giá' }
const contact = { ...unverified, price_display: 'Liên hệ báo giá' }
const cat = 'thiet-bi-ve-sinh'
beforeEach(() => useCartStore.setState({ items: [], isOpen: false }))

describe('#470 Production PDP (cart OFF)', () => {
    it('shows price, original and the voucher as a separate line; voucher is not deducted from the price; no cart button', () => {
        render(<ProductPurchasePanel product={priced} categorySlug={cat} canonicalPricing cartEnabled={false} />)
        expect(screen.getByText(/900\.000/)).toBeInTheDocument()
        expect(screen.getByText(/1\.000\.000/)).toBeInTheDocument()
        expect(screen.getByText('50.000đ')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Thêm vào giỏ/ })).not.toBeInTheDocument()
        expect(screen.getByText('Gọi tư vấn')).toBeInTheDocument()
        expect(screen.queryByText(/giỏ/)).not.toBeInTheDocument()      // cart is OFF: no wording that promises a cart step
    })
    it('unverified and CONTACT_VERIFIED rows use different labels and never show a price, voucher or cart', () => {
        const { unmount } = render(<ProductPurchasePanel product={unverified} categorySlug={cat} canonicalPricing cartEnabled={false} />)
        expect(screen.getByText('Cần liên hệ xác nhận giá')).toBeInTheDocument()
        expect(screen.queryByText('Liên hệ báo giá')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Thêm vào giỏ/ })).not.toBeInTheDocument()
        unmount()
        render(<ProductPurchasePanel product={contact} categorySlug={cat} canonicalPricing cartEnabled={false} />)
        expect(screen.getByText('Liên hệ báo giá')).toBeInTheDocument()
        expect(screen.queryByText('Cần liên hệ xác nhận giá')).not.toBeInTheDocument()
    })
    it('the TEST pilot behaviour is unchanged (cart still available when enabled)', () => {
        render(<ProductPurchasePanel product={priced} categorySlug={cat} canonicalPricing />)
        expect(screen.getByRole('button', { name: 'Thêm vào giỏ hàng' })).toBeInTheDocument()
    })
})

describe('#470 Production PLP card', () => {
    const card = (p: object) => render(<ProductCard product={{ ...p, categories: { slug: cat, name: 'VS' }, subcategories: { slug: 'chau-rua', name: 'Chậu' }, canonical_category_slug: cat } as never} href="/thiet-bi-ve-sinh/chau-rua/chau-rua" />)
    it('priced card: price + original + separate voucher, no "final online price" line', () => {
        card(priced)
        expect(screen.getByText(/900\.000/)).toBeInTheDocument(); expect(screen.getByText(/1\.000\.000/)).toBeInTheDocument()
        expect(screen.getByText(/Voucher đặt online/)).toBeInTheDocument()
        expect(screen.queryByText(/Giá cuối online/)).not.toBeInTheDocument()
    })
    it('unverified card shows the "cần liên hệ" label, contact card shows the contact label', () => {
        const { unmount } = card(unverified); expect(screen.getByText('Cần liên hệ xác nhận giá')).toBeInTheDocument(); unmount()
        card(contact); expect(screen.getByText('Liên hệ báo giá')).toBeInTheDocument()
    })
})

describe('#470 structured data', () => {
    const input = { name: 'A', sku: 'S', stock_status: 'contact', slug: 'a', categorySlug: cat, subcategorySlug: 'chau-rua', urlPath: '/thiet-bi-ve-sinh/chau-rua/a', price_provenance: 'hita-exact-v1' }
    it('Offer only with a valid price; never an availability claim; voucher not in the Offer', () => {
        const s = buildProductSchema({ ...input, price: 900_000, list_price: 1_000_000, sale_price: 900_000 }) as { offers?: Record<string, unknown> }
        expect(s.offers).toMatchObject({ '@type': 'Offer', priceCurrency: 'VND', price: 900_000 }); expect(s.offers).not.toHaveProperty('availability')
    })
    it.each([null, undefined, 0])('no Offer when the price is %s', price => {
        const s = buildProductSchema({ ...input, price }) as Record<string, unknown>
        expect(s).toMatchObject({ '@type': 'Product' }); expect(s).not.toHaveProperty('offers')
    })
    it('non-canonical quote-only products still emit nothing (unchanged)', () => {
        expect(buildProductSchema({ ...input, price_provenance: null, price: 900_000, list_price: 1_000_000 })).toBeNull()
    })
})
