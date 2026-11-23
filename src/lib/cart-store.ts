'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { InstallOption } from '@/lib/order-pricing'
import { applyOnlineVoucher } from '@/lib/cart-pricing'
import { trackAddToCart } from '@/lib/tracking'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CartItem {
    productId: number
    sku: string
    name: string
    slug: string
    categorySlug: string
    subcategorySlug?: string | null
    price: number | null
    priceDisplay: string | null
    imageUrl: string | null
    brandName?: string | null
    quantity: number
    cartItemId: string
    installOption?: InstallOption
    installationFee?: number
    onlineDiscountAmount?: number
    finalPrice?: number
    unitPriceBefore?: number
    voucherPerUnit?: number
    finalUnitPrice?: number
}

type NewCartItem = Omit<CartItem, 'quantity' | 'cartItemId' | 'unitPriceBefore' | 'voucherPerUnit' | 'finalUnitPrice'> & {
    quantity?: number
    canonicalVoucher?: { amount: number | null }
}

interface CartStore {
    items: CartItem[]
    isOpen: boolean

    // Actions
    addItem: (item: NewCartItem) => boolean
    removeItem: (cartItemId: string) => void
    updateQuantity: (cartItemId: string, qty: number) => void
    clearCart: () => void
    openCart: () => void
    closeCart: () => void
    toggleCart: () => void

    // Computed (via selectors below)
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useCartStore = create<CartStore>()(
    persist(
        (set, get) => ({
            items: [],
            isOpen: false,

            addItem: (item) => {
                const { quantity = 1, installOption = 'none', canonicalVoucher, ...rest } = item
                const cartItemId = `${rest.productId}-${installOption}`
                if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) return false

                const existing = get().items.find(i => i.cartItemId === cartItemId && i.sku === rest.sku)
                const alreadyPriced = existing?.finalUnitPrice !== undefined
                if (canonicalVoucher && (rest.categorySlug !== 'thiet-bi-ve-sinh' || !rest.sku.trim() || !rest.price)) return false

                const priced = canonicalVoucher && !alreadyPriced
                    ? applyOnlineVoucher({ unitPrice: rest.price!, voucherAmount: canonicalVoucher.amount, quantity })
                    : undefined
                if (priced === null) return false

                const unitPrices = priced && {
                    unitPriceBefore: priced.unitPriceBefore,
                    voucherPerUnit: priced.voucherPerUnit,
                    finalUnitPrice: priced.finalUnitPrice,
                }
                const nextQuantity = Math.min((existing?.quantity ?? 0) + quantity, 99)

                // Track Add to Cart
                trackAddToCart({
                    item_id: rest.sku || rest.productId.toString(),
                    item_name: rest.name,
                    price: rest.price || 0,
                    quantity,
                    item_category: rest.categorySlug,
                    item_brand: rest.brandName || undefined,
                })

                const line = existing && !unitPrices
                    ? { ...existing, quantity: nextQuantity }
                    : { ...rest, ...unitPrices, quantity: nextQuantity, installOption, cartItemId }
                set((state) => ({
                    items: state.items.some(i => i.cartItemId === cartItemId)
                        ? state.items.map(i => i.cartItemId === cartItemId ? line : i)
                        : [...state.items, line],
                    isOpen: true,
                }))
                return true
            },

            removeItem: (cartItemId) => {
                set((state) => ({
                    items: state.items.filter(i => i.cartItemId !== cartItemId),
                }))
            },

            updateQuantity: (cartItemId, qty) => {
                if (!Number.isSafeInteger(qty)) return
                if (qty < 1) {
                    get().removeItem(cartItemId)
                    return
                }
                set((state) => ({
                    items: state.items.map(i =>
                        i.cartItemId === cartItemId
                            ? { ...i, quantity: Math.min(qty, 99) }
                            : i
                    ),
                }))
            },

            clearCart: () => set({ items: [] }),

            openCart: () => set({ isOpen: true }),
            closeCart: () => set({ isOpen: false }),
            toggleCart: () => set((state) => ({ isOpen: !state.isOpen })),
        }),
        {
            name: 'dpg-cart',
            // Only persist items, not UI state
            partialize: (state) => ({ items: state.items }),
        }
    )
)

// ─── Selectors ────────────────────────────────────────────────────────────────

export const useCartCount = () =>
    useCartStore((state) => state.items.reduce((sum, i) => sum + i.quantity, 0))

export const getCartUnitPrice = (item: CartItem) => item.finalUnitPrice ?? item.finalPrice ?? item.price

export const useCartTotal = () =>
    useCartStore((state) =>
        state.items.reduce((sum, i) => sum + (getCartUnitPrice(i) ?? 0) * i.quantity, 0)
    )

export const useCartHasPricedItems = () =>
    useCartStore((state) => state.items.some(i => (getCartUnitPrice(i) ?? 0) > 0))
