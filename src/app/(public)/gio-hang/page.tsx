import { notFound } from 'next/navigation'
import { CommerceCartPage } from '@/components/commerce/cart-page'
import { commerceEnabled } from '@/lib/commerce/flags'

export const dynamic = 'force-dynamic'

// #470 commerce v1: closed (404) wherever commerce is not enabled.
export default function CartRoute() {
    if (!commerceEnabled()) notFound()
    return <CommerceCartPage />
}
