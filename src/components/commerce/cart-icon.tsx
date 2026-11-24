'use client'

import Link from 'next/link'
import { ShoppingCart } from 'lucide-react'
import { useCommerceCartCount } from '@/lib/commerce/cart-store'

export function CommerceCartIcon() {
    const count = useCommerceCartCount()
    return (
        <Link prefetch={false} href="/gio-hang" aria-label={`Giỏ hàng${count > 0 ? ` (${count} sản phẩm)` : ''}`}
            className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-stone-700 transition-colors hover:bg-stone-100 hover:text-brand-600">
            <ShoppingCart className="h-[22px] w-[22px] text-current" strokeWidth={2} aria-hidden="true" />
            {count > 0 && (
                <span className="absolute right-[2px] top-[4px] flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-white bg-brand-500 px-1 text-[10px] font-bold leading-none text-white shadow-sm">
                    {count > 99 ? '99+' : count}
                </span>
            )}
        </Link>
    )
}
