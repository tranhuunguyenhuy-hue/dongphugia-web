import { ProductVariantLink } from '@/components/layout/public-navigation-feedback'

// The PDP supplies the current SKU and eligible siblings with their canonical URLs.
export type VerifiedVariantOption = {
    sku: string
    href: string
    attributes: readonly { label: string; value: string }[]
}

export function readVerifiedVariantAttributes(value: unknown, sku: string): VerifiedVariantOption['attributes'] {
    if (!Array.isArray(value)) return []
    return value.flatMap((attribute: unknown) => {
        if (!attribute || typeof attribute !== 'object' || !('label' in attribute) || !('value' in attribute)) return []
        const label = typeof attribute.label === 'string' ? attribute.label.trim() : ''
        const text = typeof attribute.value === 'string' ? attribute.value.trim() : ''
        return label && text && text.toUpperCase() !== sku.toUpperCase() ? [{ label, value: text }] : []
    })
}

export function VerifiedVariantSelector({ currentSku, options }: {
    currentSku: string
    options: readonly VerifiedVariantOption[]
}) {
    if (!options.some(option => option.sku !== currentSku)) return null

    // The PDP supplies the current SKU first. Use SKU identity for the group order.
    const orderedOptions = [...options].sort((a, b) => {
        if (a.sku === b.sku) return 0
        return a.sku < b.sku ? -1 : 1
    })

    return (
        <section aria-label="Biến thể sản phẩm" className="space-y-2">
            <h2 className="text-sm font-semibold text-neutral-800">Biến thể sản phẩm</h2>
            <ul className="flex flex-wrap gap-2">
                {orderedOptions.map(option => {
                    const current = option.sku === currentSku
                    return (
                        <li key={option.sku}>
                            <ProductVariantLink
                                href={option.href}
                                current={current}
                                className={`flex min-h-11 flex-col justify-center rounded-md border px-3 py-2 text-sm ${
                                    current ? 'border-[#2E7A96] bg-[#2E7A96]/8' : 'border-neutral-200 hover:border-[#2E7A96]'
                                }`}
                            >
                                {option.attributes.map(attribute => (
                                    <span key={attribute.label}>{attribute.label}: {attribute.value}</span>
                                ))}
                                <span className="text-xs text-neutral-600">{option.sku}</span>
                            </ProductVariantLink>
                        </li>
                    )
                })}
            </ul>
        </section>
    )
}
