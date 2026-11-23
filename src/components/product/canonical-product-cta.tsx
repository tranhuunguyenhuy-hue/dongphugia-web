'use client'

import { ShoppingBag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { siteConfig, siteLinks } from '@/config/site'
import { useCartStore } from '@/lib/cart-store'

type Props = {
    id: number
    sku: string
    name: string
    slug: string
    categorySlug: string
    subcategorySlug?: string | null
    price: number | null
    voucher: number | null
    imageUrl: string | null
    brandName?: string | null
    canOrder: boolean
}

export function CanonicalProductCTA({ price, voucher, canOrder, id, ...product }: Props) {
    const addItem = useCartStore(state => state.addItem)

    return (
        <div className="grid gap-3">
            {canOrder && price !== null && product.sku.trim() && product.sku.length <= 100 && (
                <Button type="button" className="h-12 w-full bg-brand-700 text-white hover:bg-brand-800"
                    onClick={() => addItem({ ...product, productId: id, price, priceDisplay: null, canonicalVoucher: { amount: voucher } })}>
                    <ShoppingBag aria-hidden="true" />
                    Thêm vào giỏ hàng
                </Button>
            )}
            <div className="flex flex-wrap gap-3">
                <a className="rounded-xl border border-brand-700 px-4 py-2 font-semibold text-brand-700"
                    href={`tel:${siteConfig.contact.hotline}`}>Gọi tư vấn</a>
                <a className="rounded-xl border border-brand-700 px-4 py-2 font-semibold text-brand-700"
                    href={siteLinks.zalo} rel="noopener noreferrer" target="_blank">Nhận báo giá qua Zalo</a>
            </div>
        </div>
    )
}
