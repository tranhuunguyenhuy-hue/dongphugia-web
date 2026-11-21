import Link from 'next/link'

// The PDP supplies the current SKU and eligible siblings with their canonical URLs.
export type VerifiedVariantOption = {
    sku: string
    href: string
    attributes: readonly { label: string; value: string }[]
}

export function VerifiedVariantSelector({ currentSku, options }: {
    currentSku: string
    options: readonly VerifiedVariantOption[]
}) {
    if (!options.some(option => option.sku !== currentSku)) return null

    return (
        <section aria-label="Biến thể sản phẩm" className="space-y-2">
            <h2 className="text-sm font-semibold text-neutral-800">Biến thể sản phẩm</h2>
            <ul className="flex flex-wrap gap-2">
                {options.map(option => {
                    const current = option.sku === currentSku
                    return (
                        <li key={option.sku}>
                            <Link
                                href={option.href}
                                prefetch={false}
                                aria-current={current ? 'page' : undefined}
                                className={`flex min-h-11 flex-col justify-center rounded-md border px-3 py-2 text-sm ${
                                    current ? 'border-[#2E7A96] bg-[#2E7A96]/8' : 'border-neutral-200 hover:border-[#2E7A96]'
                                }`}
                            >
                                {option.attributes.map(attribute => (
                                    <span key={attribute.label}>{attribute.label}: {attribute.value}</span>
                                ))}
                                <span className="text-xs text-neutral-600">{option.sku}</span>
                            </Link>
                        </li>
                    )
                })}
            </ul>
        </section>
    )
}
