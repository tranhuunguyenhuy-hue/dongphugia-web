// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import Link from 'next/link'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PUBLIC_NAVIGATION_START, type PublicNavigationStart } from './public-navigation-event'
import { ProductVariantLink, PublicContent, PublicNavigationFeedback } from './public-navigation-feedback'

const router = vi.hoisted(() => ({ pathname: '/sku-a', search: '' }))
vi.mock('next/navigation', () => ({
    usePathname: () => router.pathname,
    useSearchParams: () => new URLSearchParams(router.search),
}))

vi.mock('next/link', () => ({
    default: ({ children, prefetch: _prefetch, ...props }: React.ComponentProps<'a'> & { prefetch?: boolean }) => (
        <a {...props}>{children}</a>
    ),
}))

function start(href: string, type: PublicNavigationStart['detail']['type'] = 'push') {
    act(() => {
        window.dispatchEvent(new CustomEvent(PUBLIC_NAVIGATION_START, { detail: { href, type } }))
    })
}

function page() {
    return (
        <PublicNavigationFeedback>
            <PublicContent>
                {['a', 'b', 'c'].map(sku => (
                    <ProductVariantLink key={sku} href={`/sku-${sku}`} current={router.pathname === `/sku-${sku}`} className="">
                        {sku}
                    </ProductVariantLink>
                ))}
                <a href="#main-content">Bỏ qua</a>
                <Link href="/blog">Blog</Link>
            </PublicContent>
        </PublicNavigationFeedback>
    )
}

describe('Public navigation feedback', () => {
    beforeEach(() => {
        router.pathname = '/sku-a'
        router.search = ''
        window.history.replaceState(null, '', '/sku-a')
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('keeps the current SKU active until the latest variant commits', () => {
        const { rerender } = render(page())
        start('/sku-b')
        expect(screen.getByRole('status')).toHaveTextContent('Đang tải biến thể')
        expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true')
        expect(screen.getByRole('link', { name: 'a' })).toHaveAttribute('aria-current', 'page')
        expect(screen.getByRole('link', { name: 'b' })).toHaveAttribute('aria-busy', 'true')
        expect(fireEvent.click(screen.getByRole('link', { name: 'b' }))).toBe(false)

        start('/sku-c')
        expect(screen.getByRole('link', { name: 'b' })).not.toHaveAttribute('aria-busy')
        expect(screen.getByRole('link', { name: 'c' })).toHaveAttribute('aria-busy', 'true')
        router.pathname = '/sku-c'
        rerender(page())
        expect(screen.getByRole('link', { name: 'c' })).toHaveAttribute('aria-current', 'page')
        expect(screen.getByRole('main')).not.toHaveAttribute('aria-busy')
        expect(screen.getByRole('status')).toBeEmptyDOMElement()
    })

    it('settles query-only navigation and cancels feedback when history returns to the current page', () => {
        const { rerender } = render(page())
        start('/sku-a?query=mau%20thu')
        expect(screen.getByRole('status')).toHaveTextContent('Đang tải trang')
        router.search = 'query=mau+thu'
        rerender(page())
        expect(screen.getByRole('status')).toBeEmptyDOMElement()

        start('/sku-b')
        start('/sku-a?query=mau+thu', 'traverse')
        expect(screen.getByRole('status')).toBeEmptyDOMElement()
    })

    it('offers a retry to the original URL when the wait is long', () => {
        vi.useFakeTimers()
        render(page())
        start('/sku-b?q=1')
        act(() => vi.advanceTimersByTime(12_000))
        expect(screen.getByRole('status')).toHaveTextContent('Trang đang mất nhiều thời gian')
        expect(screen.getByRole('main')).not.toHaveAttribute('aria-busy')
        expect(screen.getByRole('link', { name: 'Thử lại' }).getAttribute('href')).toContain('/sku-b?q=1')

        start('/sku-c')
        expect(screen.getByRole('status')).toHaveTextContent('Đang tải biến thể')
        expect(screen.queryByRole('link', { name: 'Thử lại' })).not.toBeInTheDocument()
    })

    it('keeps the current page when offline and lets modified or hash-only clicks pass', () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
        render(page())
        expect(fireEvent.click(screen.getByRole('link', { name: 'Blog' }), { metaKey: true })).toBe(true)
        expect(fireEvent.click(screen.getByRole('link', { name: 'Bỏ qua' }))).toBe(true)
        expect(screen.getByRole('status')).toBeEmptyDOMElement()
        expect(fireEvent.click(screen.getByRole('link', { name: 'b' }))).toBe(false)
        expect(screen.getByRole('status')).toHaveTextContent('Bạn đang ngoại tuyến')
        expect(screen.getByRole('link', { current: 'page' })).toHaveTextContent('a')
        expect(screen.getByRole('link', { name: 'Thử lại' }).getAttribute('href')).toContain('/sku-b')
    })
})
