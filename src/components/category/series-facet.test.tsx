import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveFilters } from './active-filters'
import { AdvancedSidebarFilter } from './advanced-sidebar-filter'
import { CategoryMobileFilter } from './category-mobile-filter'
import type { SeriesFacet } from '@/lib/series-facet-contract'

const navigation = vi.hoisted(() => ({ push: vi.fn(), query: '', pathname: '' }))
vi.mock('next/navigation', () => ({
    usePathname: () => navigation.pathname,
    useRouter: () => ({ push: navigation.push }),
    useSearchParams: () => new URLSearchParams(navigation.query),
}))

// Synthetic view models for UI tests until #432 supplies the runtime contract.
const seriesFacet: SeriesFacet = {
    applicable: true,
    selected: [],
    dropped: [],
    options: [
        { slug: 'toto-a', brandSlug: 'toto', name: 'Mẫu A', count: 3, selected: false },
        { slug: 'toto-b', brandSlug: 'toto', name: 'Mẫu B', count: 2, selected: false },
        { slug: 'toto-zero', brandSlug: 'toto', name: 'Mẫu hết kết quả', count: 0, selected: false },
        { slug: 'inax-a', brandSlug: 'inax', name: 'Mẫu C', count: 1, selected: false },
    ],
}
const availableFilters = {
    subcategories: [], materials: [], origins: [], features: [],
    brands: [{ slug: 'toto', name: 'TOTO' }, { slug: 'inax', name: 'INAX' }],
    seriesFacet,
}

function pushedQuery() {
    const [href] = navigation.push.mock.lastCall ?? []
    return new URL(href, 'https://example.test').searchParams
}

describe('Dòng sản phẩm', () => {
    beforeEach(() => {
        navigation.push.mockReset()
        navigation.pathname = '/thiet-bi-ve-sinh/voi-lavabo'
        navigation.query = ''
    })

    it('uses counts from the current category and brand, hiding empty contexts', () => {
        const { rerender } = render(<AdvancedSidebarFilter availableFilters={availableFilters} />)
        expect(screen.queryByRole('group', { name: 'Dòng sản phẩm' })).not.toBeInTheDocument()

        navigation.query = 'brand=toto'
        rerender(<AdvancedSidebarFilter availableFilters={availableFilters} />)
        const group = screen.getByRole('group', { name: 'Dòng sản phẩm' })
        expect(within(group).getAllByRole('button').map(button => button.textContent))
            .toEqual(['Mẫu A (3)', 'Mẫu B (2)'])

        navigation.pathname = '/thiet-bi-ve-sinh/sen-tam'
        const otherCategory = { ...seriesFacet, options: [{ ...seriesFacet.options[1], count: 6 }] }
        rerender(<AdvancedSidebarFilter availableFilters={{ ...availableFilters, seriesFacet: otherCategory }} />)
        expect(screen.getByRole('button', { name: 'Mẫu B (6)' })).toBeVisible()
        expect(screen.queryByRole('button', { name: 'Mẫu A (3)' })).not.toBeInTheDocument()

        navigation.query = 'brand=inax'
        rerender(<AdvancedSidebarFilter availableFilters={{ ...availableFilters, seriesFacet: otherCategory }} />)
        expect(screen.queryByRole('group', { name: 'Dòng sản phẩm' })).not.toBeInTheDocument()
    })

    it('serializes OR selections and preserves other filters, including when URL state changes', () => {
        const initial = 'brand=toto&dong=toto-a&features=gan-tuong&sort=newest&page=4'
        navigation.query = initial
        const { rerender } = render(<AdvancedSidebarFilter availableFilters={availableFilters} />)
        expect(screen.getByRole('button', { name: 'Mẫu A (3)', pressed: true })).toBeVisible()
        fireEvent.click(screen.getByRole('button', { name: 'Mẫu B (2)', pressed: false }))
        const next = pushedQuery()
        expect(Object.fromEntries(next)).toEqual({
            brand: 'toto', dong: 'toto-a,toto-b', features: 'gan-tuong', sort: 'newest', page: '1',
        })

        for (const [query, pressed] of [[next.toString(), true], [initial, false], [next.toString(), true]] as const) {
            navigation.query = query
            rerender(<AdvancedSidebarFilter availableFilters={availableFilters} />)
            expect(screen.getByRole('button', { name: 'Mẫu B (2)', pressed })).toBeVisible()
        }
    })

    it('removes only incompatible series when a brand chip is removed', () => {
        navigation.query = 'brand=toto,inax&dong=toto-a,inax-a&features=gan-tuong'
        render(<ActiveFilters filterDict={{ toto: 'TOTO', inax: 'INAX' }} seriesFacet={seriesFacet} />)
        expect(screen.getByRole('button', { name: 'Xoá lọc Mẫu A' })).toBeVisible()
        fireEvent.click(screen.getByRole('button', { name: 'Xoá lọc TOTO' }))
        expect(Object.fromEntries(pushedQuery())).toEqual({
            brand: 'inax', dong: 'inax-a', features: 'gan-tuong', page: '1',
        })
        fireEvent.click(screen.getByRole('button', { name: 'Xoá lọc Mẫu C' }))
        expect(pushedQuery().get('dong')).toBe('toto-a')
        fireEvent.click(screen.getByRole('button', { name: 'Xóa tất cả' }))
        expect(pushedQuery().has('dong')).toBe(false)
    })

    it('shows the same series labels and clear action in the mobile sheet', async () => {
        navigation.query = 'brand=toto&dong=toto-a'
        render(<CategoryMobileFilter availableFilters={availableFilters} />)
        fireEvent.click(screen.getByRole('button', { name: /bộ lọc/i }))
        expect(await screen.findByRole('button', { name: 'Mẫu A (3)', pressed: true })).toBeVisible()
        fireEvent.click(screen.getByRole('button', { name: 'Xoá lọc' }))
        expect(pushedQuery().has('dong')).toBe(false)
    })
})
