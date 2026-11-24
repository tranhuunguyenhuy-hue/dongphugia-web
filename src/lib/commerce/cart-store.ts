'use client'

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

// #470 commerce v1 cart. NEW storage key: nothing from the legacy cart (`dpg-cart`) is read. The store keeps ONLY what is needed to show a line and to send
// {productId, quantity}; it never stores or sends a price — the server decides every price, voucher and total (see /api/commerce/cart).
export type CartLine = {
    productId: number
    sku: string
    name: string
    slug: string
    categorySlug: string
    subcategorySlug?: string | null
    imageUrl: string | null
    brandName?: string | null
    quantity: number
}
export const CART_MAX_LINES = 20
export const CART_MAX_QUANTITY = 99
type AddResult = 'added' | 'updated' | 'full' | 'invalid'
type CartState = {
    lines: CartLine[]
    add: (line: Omit<CartLine, 'quantity'>, quantity?: number) => AddResult
    setQuantity: (productId: number, quantity: number) => void
    remove: (productId: number) => void
    removeMany: (productIds: number[]) => void
    clear: () => void
}

const clampQuantity = (value: number) => Math.min(CART_MAX_QUANTITY, Math.max(1, Math.trunc(value)))

export const useCommerceCart = create<CartState>()(
    persist(
        (set, get) => ({
            lines: [],
            add: (line, quantity = 1) => {
                if (!Number.isSafeInteger(line.productId) || line.productId < 1 || !line.sku.trim() || !Number.isSafeInteger(quantity) || quantity < 1) return 'invalid'
                const existing = get().lines.find(item => item.productId === line.productId)
                if (existing) {
                    set({ lines: get().lines.map(item => (item.productId === line.productId ? { ...item, quantity: clampQuantity(item.quantity + quantity) } : item)) })
                    return 'updated'
                }
                if (get().lines.length >= CART_MAX_LINES) return 'full'
                set({ lines: [...get().lines, { ...line, quantity: clampQuantity(quantity) }] })
                return 'added'
            },
            setQuantity: (productId, quantity) => {
                if (!Number.isFinite(quantity)) return
                set({ lines: get().lines.map(item => (item.productId === productId ? { ...item, quantity: clampQuantity(quantity) } : item)) })
            },
            remove: productId => set({ lines: get().lines.filter(item => item.productId !== productId) }),
            removeMany: productIds => set({ lines: get().lines.filter(item => !productIds.includes(item.productId)) }),
            clear: () => set({ lines: [] }),
        }),
        { name: 'dpg-cart-v2', version: 1, storage: createJSONStorage(() => localStorage), partialize: state => ({ lines: state.lines }) },
    ),
)

export const useCommerceCartCount = () => useCommerceCart(state => state.lines.reduce((sum, line) => sum + line.quantity, 0))
