'use client'

import { siteConfig, siteLinks } from '@/config/site'
import { ViewItemTracker } from '@/components/tracking/view-item-tracker'
import { CommerceProductCTA } from '@/components/commerce/product-cta'
import type { CartLine } from '@/lib/commerce/cart-store'

type Props = {
    /** server-decided: commerceEnabled() */
    commerce: boolean
    /** true only for a SKU the page shows with an official price; the SERVER re-checks eligibility on every cart/submit */
    canOrder: boolean
    product: Omit<CartLine, 'quantity'>
    price: number | null
}

/** #470 commerce v1: the ONLY product action block. Commerce OFF => contact actions only (no cart, no legacy flow). Commerce ON => add to cart / request a quote. */
export function ProductActions({ commerce, canOrder, product, price }: Props) {
    return (
        <>
            <ViewItemTracker item={{ item_id: product.sku || String(product.productId), item_name: product.name, price: price ?? 0, item_category: product.categorySlug, item_brand: product.brandName ?? undefined }} />
            {commerce ? <CommerceProductCTA product={product} canOrder={canOrder} /> : (
                <div className="flex flex-wrap gap-3">
                    <a className="rounded-xl border border-brand-700 px-4 py-2 font-semibold text-brand-700" href={`tel:${siteConfig.contact.hotline}`}>Gọi tư vấn</a>
                    <a className="rounded-xl border border-brand-700 px-4 py-2 font-semibold text-brand-700" href={siteLinks.zalo} rel="noopener noreferrer" target="_blank">Nhận báo giá qua Zalo</a>
                </div>
            )}
        </>
    )
}
