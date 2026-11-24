'use server'

import { assertAdminLaunchModuleEnabled } from '@/lib/admin-launch-scope'
import prisma from "@/lib/prisma"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { requirePermission } from '@/lib/auth/get-current-user'
import { toWriteFreezeActionResult } from '@/lib/write-freeze'
import { buildQuoteItemSnapshot } from '@/lib/quote-snapshot'
import { resolveProductVisibility } from '@/lib/public-product-visibility'

// NOTE: Legacy product/collection/pattern-type actions removed in LEO-366.
// Will be rebuilt as unified product actions in Phase 3.

// --- Banners ---
const bannerSchema = z.object({
    title: z.string().optional().nullable(),
    image_url: z.string().min(1, "URL ảnh là bắt buộc"),
    link_url: z.string().optional().nullable(),
    is_active: z.boolean().default(true),
    sort_order: z.coerce.number().int().optional().default(0),
})

export async function createBanner(data: unknown) {
    assertAdminLaunchModuleEnabled('banners')
    await requirePermission('blog:write')
    
    const validated = bannerSchema.safeParse(data)
    if (!validated.success) {
        return { errors: validated.error.flatten().fieldErrors }
    }
    const d = validated.data
    try {
        await prisma.banners.create({
            data: {
                title: d.title || null,
                image_url: d.image_url,
                link_url: d.link_url || null,
                is_active: d.is_active,
                sort_order: d.sort_order,
            },
        })
    } catch (error) {
        const freezeResult = toWriteFreezeActionResult(error)
        if (freezeResult) return freezeResult
        console.error("Database Error:", error)
        return { message: 'Lỗi database khi tạo banner.' }
    }
    revalidatePath('/admin/banners')
    revalidatePath('/')
    return { success: true }
}

export async function updateBanner(id: number, data: unknown) {
    assertAdminLaunchModuleEnabled('banners')
    await requirePermission('blog:write')

    const validated = bannerSchema.safeParse(data)
    if (!validated.success) {
        return { errors: validated.error.flatten().fieldErrors }
    }
    const d = validated.data
    try {
        await prisma.banners.update({
            where: { id },
            data: {
                title: d.title || null,
                image_url: d.image_url,
                link_url: d.link_url || null,
                is_active: d.is_active,
                sort_order: d.sort_order,
                updated_at: new Date(),
            },
        })
    } catch (error) {
        const freezeResult = toWriteFreezeActionResult(error)
        if (freezeResult) return freezeResult
        console.error("Database Error:", error)
        return { message: 'Lỗi database khi cập nhật banner.' }
    }
    revalidatePath('/admin/banners')
    revalidatePath('/')
    return { success: true }
}

export async function deleteBanner(id: number) {
    assertAdminLaunchModuleEnabled('banners')
    await requirePermission('blog:write')

    try {
        await prisma.banners.delete({ where: { id } })
        revalidatePath('/admin/banners')
        revalidatePath('/')
        return { success: true }
    } catch (error) {
        const freezeResult = toWriteFreezeActionResult(error)
        if (freezeResult) return freezeResult
        console.error("Database Error:", error)
        return { success: false, message: 'Lỗi database khi xóa banner.' }
    }
}

// --- Category Banners ---
export async function updateCategoryBanner(id: number, banner_url: string | null) {
    assertAdminLaunchModuleEnabled('categories')
    await requirePermission('categories:write')

    try {
        await prisma.categories.update({
            where: { id },
            data: { banner_url: banner_url || null },
        })
        revalidatePath('/admin/categories')
        revalidatePath('/thiet-bi-ve-sinh')
        revalidatePath('/thiet-bi-bep')
        revalidatePath('/vat-lieu-nuoc')
        revalidatePath('/gach-op-lat')
        return { success: true }
    } catch (error) {
        const freezeResult = toWriteFreezeActionResult(error)
        if (freezeResult) return freezeResult
        console.error("Database Error:", error)
        return { success: false, message: 'Lỗi khi cập nhật banner danh mục.' }
    }
}

export async function submitContactForm(data: { name: string, phone: string, email?: string, message: string }) {
    try {
        await prisma.customers.upsert({
            where: { phone: data.phone },
            create: {
                full_name: data.name,
                phone: data.phone,
                email: data.email || null,
                notes: `Khách hàng từ Form Liên Hệ:\n${data.message}`,
                source: 'CONTACT_FORM'
            },
            update: {
                last_interacted_at: new Date(),
                notes: `[Cập nhật mới]: Khách hàng gửi form liên hệ với nội dung:\n${data.message}`
            }
        })
        revalidatePath('/admin/customers')
        return { success: true }
    } catch (error) {
        const freezeResult = toWriteFreezeActionResult(error)
        if (freezeResult) return freezeResult
        console.error("Lỗi khi lưu form liên hệ:", error)
        return { success: false, error: 'Có lỗi xảy ra, vui lòng thử lại sau.' }
    }
}
