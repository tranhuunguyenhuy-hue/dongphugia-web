import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { VerifiedVariantSelector, type VerifiedVariantOption } from '../verified-variant-selector'

// These options represent the already-eligible set that the API must supply.
const options: VerifiedVariantOption[] = Array.from({ length: 20 }, (_, index) => ({
    sku: `MOCK-${index}`,
    href: `/thiet-bi-ve-sinh/sen-tam/mau-thu-${100 - index}`,
    attributes: [
        { label: 'Màu', value: `Màu thử ${index}` },
        { label: 'Kích thước', value: '100 mm' },
    ],
}))

describe('VerifiedVariantSelector', () => {
    it('shows every supplied option and uses the exact SKU URL and attribute labels', () => {
        render(<VerifiedVariantSelector currentSku={options[0].sku} options={options} />)
        expect(screen.getAllByRole('link')).toHaveLength(20)
        expect(screen.getByRole('link', { current: 'page' })).toHaveAttribute('href', options[0].href)
        expect(screen.getByRole('link', { name: /Màu: Màu thử 19 Kích thước: 100 mm MOCK-19/ }))
            .toHaveAttribute('href', options[19].href)
    })

    it('hides the group when no alternate SKU is supplied', () => {
        render(<VerifiedVariantSelector currentSku={options[0].sku} options={options.slice(0, 1)} />)
        expect(screen.queryByRole('region', { name: 'Biến thể sản phẩm' })).not.toBeInTheDocument()
    })
})
