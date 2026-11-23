import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { CartPage } from '@/components/cart/cart-page'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = {
    title: 'Giỏ hàng | Đông Phú Gia',
    robots: { index: false, follow: false },
}

export default function PublicCartRoute() {
    if (process.env.APP_ENV !== 'staging' || process.env.PREVIEW_TEST_DATABASE_ISOLATED !== 'true') notFound()
    return <CartPage isolatedCheckout />
}
