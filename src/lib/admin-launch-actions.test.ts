import { describe, expect, it } from 'vitest'
import { can } from './auth/permissions'
import {
    assertAdminLaunchModuleEnabled,
    isAdminLaunchPathAllowed,
    type AdminLaunchModule,
} from './admin-launch-scope'

const enabledModules: AdminLaunchModule[] = [
    'products',
    'blog-posts',
    'orders',
    'customers',
    'quote-requests',
    'dashboard',
    'banners',
    'categories',
    'pim',
    'partners',
    'projects',
    'users',
    'blog-tags',
]

describe('legacy Admin launch scope', () => {
    it.each(enabledModules)('enables the inventoried %s module', (module) => {
        expect(() => assertAdminLaunchModuleEnabled(module)).not.toThrow()
    })

    it.each([
        '/admin',
        '/admin/login',
        '/admin/products/42',
        '/admin/blog/tags',
        '/admin/orders',
        '/admin/customers/new',
        '/admin/quote-requests/42/builder',
        '/admin/banners/new',
        '/admin/content/banners',
        '/admin/categories/42',
        '/admin/pim/specifications',
        '/admin/doi-tac/new',
        '/admin/du-an/new',
        '/admin/users',
    ])('allows inventoried route %s', (pathname) => {
        expect(isAdminLaunchPathAllowed(pathname)).toBe(true)
    })

    it.each([
        '/admin/unknown',
        '/admin/unknown/nested',
        '/admin/orders-old',
        '/admin/login-extra',
        '/administrator',
    ])('denies route outside the legacy surface: %s', (pathname) => {
        expect(isAdminLaunchPathAllowed(pathname)).toBe(false)
    })

    it('keeps role-based read and write boundaries for non-admin users', () => {
        expect(can('sale_manager', 'products:read')).toBe(true)
        expect(can('sale_manager', 'products:write')).toBe(false)
        expect(can('sale', 'orders:read_assigned')).toBe(true)
        expect(can('sale', 'orders:read')).toBe(false)
        expect(can('sale', 'products:write')).toBe(false)
        expect(can('sale', 'blog:write')).toBe(false)
        expect(can('sale', 'quotes:read_assigned')).toBe(true)
        expect(can('sale', 'users:write')).toBe(false)
        expect(can('admin', 'users:write')).toBe(true)
    })
})
