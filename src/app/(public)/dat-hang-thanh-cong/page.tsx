import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { CommerceReceipt } from '@/components/commerce/receipt'
import { commerceEnabled } from '@/lib/commerce/flags'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = {
    title: 'Đã nhận yêu cầu | Đông Phú Gia',
    robots: { index: false, follow: false },
}

export default function ReceiptRoute() {
    if (!commerceEnabled()) notFound()
    return <CommerceReceipt />
}
