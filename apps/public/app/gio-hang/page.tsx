import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { CommerceCartPage } from '@/components/commerce/cart-page'
import { commerceEnabled } from '@/lib/commerce/flags'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = {
    title: 'Giỏ hàng | Đông Phú Gia',
    robots: { index: false, follow: false },
}

export default function PublicCartRoute() {
    if (!commerceEnabled()) notFound()
    return <CommerceCartPage />
}
