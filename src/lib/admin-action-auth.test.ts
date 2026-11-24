import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    assertAdminLaunchModuleEnabled: vi.fn(),
    requireAuth: vi.fn(),
    requirePermission: vi.fn(),
    revalidatePath: vi.fn(),
    productCreate: vi.fn(),
    blogCreate: vi.fn(),
    partnerCreate: vi.fn(),
    projectCreate: vi.fn(),
    orderFindUnique: vi.fn(),
    orderFindMany: vi.fn(),
    orderCount: vi.fn(),
    orderUpdate: vi.fn(),
}))

vi.mock('@/lib/admin-launch-scope', () => ({
    assertAdminLaunchModuleEnabled: mocks.assertAdminLaunchModuleEnabled,
}))

vi.mock('@/lib/auth/get-current-user', () => ({
    requireAuth: mocks.requireAuth,
    requirePermission: mocks.requirePermission,
    getCurrentUser: vi.fn(),
}))

vi.mock('next/cache', () => ({
    revalidatePath: mocks.revalidatePath,
}))

vi.mock('@/lib/utils', () => ({
    slugify: (value: string) => value.toLowerCase().replace(/\s+/g, '-'),
    generateOrderNumber: () => 'DPG-TEST-000001',
}))

vi.mock('@/lib/prisma', () => ({
    default: {
        products: { create: mocks.productCreate },
        blog_posts: { create: mocks.blogCreate },
        partners: { create: mocks.partnerCreate },
        projects: { create: mocks.projectCreate },
        orders: {
            findUnique: mocks.orderFindUnique,
            findMany: mocks.orderFindMany,
            count: mocks.orderCount,
            update: mocks.orderUpdate,
        },
    },
}))

import { createProduct } from './product-actions'
import { createBlogPost } from './blog-actions'
import { createPartner } from './partner-actions'
import { createProject } from './project-actions'

describe('admin Server Action authorization', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('blocks CMS mutations before writing to the database', async () => {
        mocks.requirePermission.mockRejectedValue(new Error('UNAUTHORIZED'))

        await expect(createProduct({})).rejects.toThrow('UNAUTHORIZED')
        await expect(createBlogPost({})).rejects.toThrow('UNAUTHORIZED')
        await expect(createPartner({} as never)).rejects.toThrow('UNAUTHORIZED')
        await expect(createProject({} as never)).rejects.toThrow('UNAUTHORIZED')

        expect(mocks.productCreate).not.toHaveBeenCalled()
        expect(mocks.blogCreate).not.toHaveBeenCalled()
        expect(mocks.partnerCreate).not.toHaveBeenCalled()
        expect(mocks.projectCreate).not.toHaveBeenCalled()
    })
})
