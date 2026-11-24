'use client'

import Link from 'next/link'
import { useState } from 'react'
import { FileText, ShoppingBag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { siteConfig, siteLinks } from '@/config/site'
import { CART_MAX_QUANTITY, useCommerceCart, type CartLine } from '@/lib/commerce/cart-store'

type Props = { product: Omit<CartLine, 'quantity'>; canOrder: boolean }

/** #470 commerce v1 PDP call-to-action. A SKU the server can sell directly gets "Thêm vào giỏ hàng"; every other SKU gets "Yêu cầu báo giá" (same cart, the cart splits the two). */
export function CommerceProductCTA({ product, canOrder }: Props) {
    const add = useCommerceCart(state => state.add)
    const [quantity, setQuantity] = useState(1)
    const [notice, setNotice] = useState<string | null>(null)
    const label = canOrder ? 'Thêm vào giỏ hàng' : 'Yêu cầu báo giá'
    const onAdd = () => {
        const result = add(product, quantity)
        setNotice(result === 'full' ? 'Giỏ hàng đã đủ 20 sản phẩm. Vui lòng gửi đơn/yêu cầu trước khi thêm.' : canOrder ? 'Đã thêm vào giỏ hàng.' : 'Đã thêm vào danh sách yêu cầu báo giá.')
    }
    return (
        <div className="grid gap-3">
            <div className="flex items-center gap-3">
                <label htmlFor="commerce-qty" className="text-sm font-medium text-stone-700">Số lượng</label>
                <div className="flex items-center rounded-lg border border-stone-300">
                    <button type="button" aria-label="Giảm số lượng" className="h-11 w-11 text-lg" onClick={() => setQuantity(q => Math.max(1, q - 1))}>−</button>
                    <input id="commerce-qty" inputMode="numeric" aria-label="Số lượng" className="h-11 w-14 border-x border-stone-300 text-center" value={quantity}
                        onChange={event => { const n = Number(event.target.value.replace(/\D/g, '')); setQuantity(Math.min(CART_MAX_QUANTITY, Math.max(1, n || 1))) }} />
                    <button type="button" aria-label="Tăng số lượng" className="h-11 w-11 text-lg" onClick={() => setQuantity(q => Math.min(CART_MAX_QUANTITY, q + 1))}>+</button>
                </div>
            </div>
            <Button type="button" onClick={onAdd} className="h-12 w-full bg-brand-700 text-white hover:bg-brand-800">
                {canOrder ? <ShoppingBag aria-hidden="true" /> : <FileText aria-hidden="true" />}
                {label}
            </Button>
            {notice && (
                <p role="status" className="text-sm text-emerald-700">
                    {notice} <Link prefetch={false} href="/gio-hang" className="font-semibold underline">Xem giỏ hàng</Link>
                </p>
            )}
            <div className="flex flex-wrap gap-3">
                <a className="rounded-xl border border-brand-700 px-4 py-2 font-semibold text-brand-700" href={`tel:${siteConfig.contact.hotline}`}>Gọi tư vấn</a>
                <a className="rounded-xl border border-brand-700 px-4 py-2 font-semibold text-brand-700" href={siteLinks.zalo} rel="noopener noreferrer" target="_blank">Chat Zalo</a>
            </div>
        </div>
    )
}
