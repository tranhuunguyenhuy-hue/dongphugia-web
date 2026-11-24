'use client'

import { useMemo, useState } from 'react'
import type { VariantSibling } from '@/lib/public-api-products'
import { ProductActions } from '@/components/commerce/product-actions'
import { ProductPrice } from '@/components/product/product-price'
import { HistoricalReferencePriceNotice } from '@/components/product/historical-reference-price'
import { canonicalPriceLabel } from '@/lib/canonical-price'
import { VariantPreview, VariantSelector } from '@/components/product/variant-selector'; import { resolveProductCommerce } from '@/lib/product-commerce'

import { VerifiedVariantSelector, type VerifiedVariantOption } from './verified-variant-selector'

interface ProductPurchasePanelProps {
    product: {
        id: number; sku: string; slug: string; name: string; price: number | null;
        original_price: number | null; sale_price: number | null; list_price: number | null;
        online_discount_amount: number | null; price_display: string | null;
        image_main_url: string | null; product_images: {image_url:string}[];
        stock_status: string | null; is_active: boolean; variant_group: string | null;
        sale_status?: string | null; price_state?: string | null;
        variant_type: string | null; variant_label: string | null;
        colors: {name:string;hex_code:string|null}|null;
        brands: {name:string}|null;
    }
    canonicalPricing?: boolean
    /** #470: Production keeps cart/checkout OFF; only the TEST pilot passes true. Defaults to true to preserve the pilot behaviour. */
    cartEnabled?: boolean
    /** #470 commerce v1: server-decided (commerceEnabled()). OFF => contact actions only. */
    commerce?: boolean
    historicalReferencePrice?: {amountVnd:number;recordedUpdateDate:string;provenance:string}|null
    variantSiblings?: VariantSibling[]
    verifiedVariantOptions?: readonly VerifiedVariantOption[]
    variantAxes?: unknown
    currentVariantOptions?: unknown
    categorySlug: string
    subcategorySlug?: string | null
}

const toClientMoney = (value: unknown) =>
    value === null || value === undefined ? null : Number(value)

export function ProductPurchasePanel({
    product,
    canonicalPricing = false,
    cartEnabled = true,
    commerce = false,
    historicalReferencePrice,
    variantSiblings = [],
    verifiedVariantOptions,
    variantAxes,
    currentVariantOptions,
    categorySlug,
    subcategorySlug,
}: ProductPurchasePanelProps) {
    const productKey = `${product.id}:${product.sku}`
    const [selection, setSelection] = useState<{
        productKey: string
        variant: VariantPreview
    } | null>(null)
    const selectedVariant = !canonicalPricing && !verifiedVariantOptions && selection?.productKey === productKey ? selection.variant : null

    const displayProduct = useMemo(() => {
        if (!selectedVariant) return product
        return {
            ...product,
            id: selectedVariant.id ?? product.id,
            sku: selectedVariant.sku,
            slug: selectedVariant.slug,
            name: selectedVariant.name,
            price: selectedVariant.price,
            original_price: selectedVariant.original_price,
            sale_price: selectedVariant.sale_price,
            list_price: selectedVariant.list_price,
            online_discount_amount: selectedVariant.online_discount_amount ?? product.online_discount_amount,
            price_display: selectedVariant.price_display,
            image_main_url: selectedVariant.image_main_url,
            stock_status: selectedVariant.stock_status ?? product.stock_status,
            sale_status: selectedVariant.sale_status ?? product.sale_status,
            price_state: selectedVariant.price_state ?? product.price_state,
            is_active: selectedVariant.is_active ?? product.is_active,
        }
    }, [product, selectedVariant])

    const currentCommerce = resolveProductCommerce({
        listPrice: product.list_price,
        originalPrice: product.original_price,
        salePrice: product.sale_price,
        compatibilityPrice: product.price,
        stockStatus: product.stock_status,
    })
    const displayCompatibilityPrice = canonicalPricing ? null : displayProduct.price
    const displayOriginalPrice = canonicalPricing ? null : displayProduct.list_price ?? displayProduct.original_price
    const displaySalePrice = canonicalPricing && displayProduct.list_price == null ? null : displayProduct.sale_price
    const displayVoucher = toClientMoney(displayProduct.online_discount_amount)
    const displayCommerce = resolveProductCommerce({
        listPrice: displayProduct.list_price,
        salePrice: displaySalePrice,
        stockStatus: displayProduct.stock_status,
    })
    // #470 commerce v1: a direct purchase is offered only for an active SKU shown with an official canonical price; the SERVER decides again on every cart check and submit.
    const commerceCanOrder = canonicalPricing && displayProduct.is_active
        && !['not_sellable', 'discontinued'].includes(displayProduct.sale_status ?? '')
        && displayCommerce.priceMode === 'PUBLIC_PRICE'
    const canOrder = cartEnabled && displayProduct.is_active
        && !['not_sellable', 'discontinued'].includes(displayProduct.sale_status ?? '')
        && displayCommerce.availability !== 'Discontinued'
        && displayCommerce.availability !== null
        && displayCommerce.priceMode === 'PUBLIC_PRICE'

    return (
        <>
            {verifiedVariantOptions ? (
                <VerifiedVariantSelector currentSku={product.sku} options={verifiedVariantOptions} />
            ) : !canonicalPricing && product.variant_group && variantSiblings.length > 0 && (
                <VariantSelector
                    currentSku={product.sku}
                    currentSlug={product.slug}
                    currentName={product.name}
                    currentImageMainUrl={product.image_main_url}
                    currentPriceDisplay={product.price_display}
                    currentPrice={currentCommerce.displayPrice}
                    currentOriginalPrice={currentCommerce.originalPrice}
                    currentColor={product.colors}
                    currentStockStatus={product.stock_status}
                    currentVariantOptions={currentVariantOptions}
                    variantAxes={variantAxes}
                    selectedSku={displayProduct.sku}
                    onPreviewVariant={(variant) => setSelection({ productKey, variant })}
                    variantType={product.variant_type}
                    variantLabel={product.variant_label}
                    variantGroup={product.variant_group}
                    siblings={variantSiblings}
                    categorySlug={categorySlug}
                    subcategorySlug={subcategorySlug}
                />
            )}

            <ProductPrice
                price={toClientMoney(displayCompatibilityPrice)}
                originalPrice={toClientMoney(displayOriginalPrice)}
                listPrice={toClientMoney(displayProduct.list_price)}
                salePrice={toClientMoney(displaySalePrice)}
                priceDisplay={canonicalPricing ? canonicalPriceLabel(displayProduct.price_display) : displayProduct.price_display}
                displayVoucherOnly={canonicalPricing}
                voucherCartNote={commerce}
                onlineDiscountAmount={displayVoucher}
                stockStatus={displayProduct.stock_status}
            >
                <ProductActions
                    commerce={commerce}
                    canOrder={commerceCanOrder}
                    price={displayCommerce.displayPrice}
                    product={{ productId: displayProduct.id, sku: displayProduct.sku, name: displayProduct.name, slug: displayProduct.slug, categorySlug, subcategorySlug, imageUrl: displayProduct.image_main_url ?? null, brandName: displayProduct.brands?.name }}
                />
            </ProductPrice>
            {!canonicalPricing && <HistoricalReferencePriceNotice referencePrice={historicalReferencePrice} />}
        </>
    )
}
