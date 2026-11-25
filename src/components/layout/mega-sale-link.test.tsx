// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import Link from 'next/link'
import { describe, expect, it, vi } from 'vitest'
import { Header } from './header'
import { MobileMenuSheet } from './mobile-menu-sheet'

vi.mock('@/components/home/search-bar', () => ({
    SearchBar: () => <button type="button">Mở tìm kiếm</button>,
}))

vi.mock('@/components/commerce/cart-icon', () => ({
    CommerceCartIcon: () => <Link href="/gio-hang">Giỏ hàng</Link>,
}))

function expectCampaignLink(link: HTMLElement) {
    expect(link.tagName).toBe('A')
    expect(link).toHaveAttribute('href', '/uudaicuoinam2026/')
    expect(link).not.toHaveAttribute('target')
}

describe('MEGA SALE navigation', () => {
    it('links to the campaign beside the desktop links and keeps existing actions', () => {
        render(<Header commerce />)

        const nav = within(screen.getByRole('navigation', { name: 'Menu chính' }))
        expectCampaignLink(nav.getByRole('link', { name: 'MEGA SALE' }))
        expect(nav.getByRole('link', { name: 'Tin tức' })).toHaveAttribute('href', '/blog')
        expect(screen.getByRole('link', { name: 'Liên hệ' })).toHaveAttribute('href', '/lien-he')
        expect(screen.getByRole('link', { name: 'Đông Phú Gia - Trang chủ' })).toHaveAttribute('href', '/')
        expect(screen.getAllByRole('button', { name: 'Mở tìm kiếm' })).toHaveLength(2)
        expect(screen.getAllByRole('link', { name: 'Giỏ hàng' })).toHaveLength(2)
    })

    it('offers the same campaign link first inside the compact mobile menu', () => {
        render(<MobileMenuSheet initiallyOpen />)

        const nav = within(screen.getByRole('navigation', { name: 'Menu di động' }))
        const [firstLink] = nav.getAllByRole('link')
        expect(firstLink).toHaveAccessibleName('MEGA SALE')
        expectCampaignLink(firstLink)
        expect(nav.getByRole('link', { name: 'Thiết bị vệ sinh' })).toHaveAttribute('href', '/thiet-bi-ve-sinh')
        expect(screen.getByRole('link', { name: 'Liên hệ tư vấn' })).toHaveAttribute('href', '/lien-he')
    })
})
