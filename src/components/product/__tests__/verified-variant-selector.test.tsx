import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { readVerifiedVariantAttributes, VerifiedVariantSelector, type VerifiedVariantOption } from '../verified-variant-selector'

vi.unmock('next/link')

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
    it('reads API labels and values without replacing missing labels with a name or SKU guess', () => {
        expect(readVerifiedVariantAttributes([
            { axis: 'config', label: 'Cấu hình', value: 'Nắp đóng êm T3' },
            { axis: 'color', label: 'Màu', value: 'MOCK-0' },
            { axis: 'size', value: '100 mm' },
            null,
        ], 'MOCK-0')).toEqual([{ label: 'Cấu hình', value: 'Nắp đóng êm T3' }])
    })
    it('shows every supplied option and uses the exact SKU URL and attribute labels', () => {
        render(<VerifiedVariantSelector currentSku={options[0].sku} options={options} />)
        expect(screen.getAllByRole('link')).toHaveLength(20)
        expect(screen.getByRole('link', { current: 'page' })).toHaveAttribute('href', options[0].href)
        const lastOption = screen.getByRole('link', { name: /MOCK-19/ })
        expect(lastOption).toHaveAttribute('href', options[19].href)
        expect(within(lastOption).getByText('Màu: Màu thử 19')).toBeVisible()
        expect(within(lastOption).getByText('Kích thước: 100 mm')).toBeVisible()
    })

    it.each([7, 9, 20])('keeps %i variant cards in the same order across PDP navigation', count => {
        const group = options.slice(0, count).map((option, index) => ({
            ...option,
            sku: `MOCK-${String(index).padStart(2, '0')}`,
        }))
        const expectedUrls = group.map(option => option.href)
        const pdp = (index: number) => (
            <VerifiedVariantSelector
                currentSku={group[index].sku}
                options={[group[index], ...group.filter((_, position) => position !== index)]}
            />
        )
        const { rerender } = render(pdp(0))

        // First SKU → third → another SKU → Back → Forward.
        for (const index of [0, 2, count - 1, 2, count - 1]) {
            rerender(pdp(index))
            const cards = screen.getAllByRole('link')
            expect(cards.map(card => card.getAttribute('href'))).toEqual(expectedUrls)
            expect(screen.getByRole('link', { current: 'page' })).toBe(cards[index])
            expect(cards.filter(card => card.classList.contains('bg-[#2E7A96]/8'))).toEqual([cards[index]])
        }
    })

    it('hides the group when no alternate SKU is supplied', () => {
        render(<VerifiedVariantSelector currentSku={options[0].sku} options={options.slice(0, 1)} />)
        expect(screen.queryByRole('region', { name: 'Biến thể sản phẩm' })).not.toBeInTheDocument()
    })
})
