'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useCartStore, getCartUnitPrice, type CartItem } from '@/lib/cart-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { formatPrice } from '@/lib/utils'
import { Minus, Plus, Trash2, Package2, ShoppingBag, ArrowLeft, Loader2 } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'
import { trackPurchase } from '@/lib/tracking'

const VIETNAM_MOBILE_PATTERN = /^(?:\+84|0)(?:3|5|7|8|9)\d{8}$/

const ORDER_ERROR = 'Đã có lỗi xảy ra. Vui lòng thử lại.'

type OrderResponse = {
    success?: unknown
    order_number?: unknown
    error?: unknown
    code?: unknown
    total?: unknown
}

// Keep the request key across network failures and reloads without storing contact details.
async function orderAttemptStorageKey(body: string) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
    const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    return `dpg-order-attempt:${fingerprint}`
}

function legacySanitaryLine(item: CartItem) {
    return item.categorySlug === 'thiet-bi-ve-sinh' && item.finalUnitPrice === undefined
}

export function CartPage({ isolatedCheckout = false }: { isolatedCheckout?: boolean }) {
    const router = useRouter()
    const { items, removeItem, updateQuantity, clearCart } = useCartStore()
    const attempt = useRef<{ storageKey: string; key: string } | null>(null)
    const submitting = useRef(false)
    const [orderNumber, setOrderNumber] = useState<string | null>(null)
    const [submitError, setSubmitError] = useState<string | null>(null)
    const [isSubmitting, setIsSubmitting] = useState(false)
    const [form, setForm] = useState({
        customer_name: '',
        customer_phone: '',
        customer_email: '',
        customer_address: '',
        note: '',
    })

    const needsRefresh = isolatedCheckout && items.some(legacySanitaryLine)
    const orderBlocked = needsRefresh || (isolatedCheckout && (items.length > 20 || items.some(item => {
        const price = getCartUnitPrice(item)
        return !item.sku?.trim() || item.sku.length > 100 || price === null || price <= 0
    })))
    const total = items.reduce((sum, item) =>
        sum + (isolatedCheckout && legacySanitaryLine(item) ? 0 : (getCartUnitPrice(item) ?? 0) * item.quantity), 0)
    const normalizedPhone = form.customer_phone.replace(/[\s().-]/g, '')
    const phoneIsInvalid = form.customer_phone.length > 0 && !VIETNAM_MOBILE_PATTERN.test(normalizedPhone)

    const handleClearCart = () => {
        if (window.confirm('Xóa toàn bộ sản phẩm khỏi giỏ hàng?')) {
            clearCart()
        }
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (submitting.current || items.length === 0 || orderBlocked) return
        if (!VIETNAM_MOBILE_PATTERN.test(normalizedPhone)) {
            setSubmitError('Vui lòng nhập số điện thoại Việt Nam hợp lệ.')
            return
        }

        submitting.current = true
        setIsSubmitting(true)
        setSubmitError(null)
        try {
            const body = JSON.stringify({
                customer_name: form.customer_name.trim(),
                customer_phone: normalizedPhone,
                customer_email: form.customer_email.trim(),
                customer_address: form.customer_address.trim(),
                note: form.note.trim(),
                items: items.map(({ productId, sku, quantity, installOption }) => ({
                    productId, sku, quantity, installOption: installOption ?? 'none',
                })),
            })
            const headers: Record<string, string> = { 'Content-Type': 'application/json' }
            if (isolatedCheckout) {
                const storageKey = await orderAttemptStorageKey(body)
                if (attempt.current?.storageKey !== storageKey) {
                    let storedKey: string | null = null
                    try { storedKey = sessionStorage.getItem(storageKey) } catch { /* Storage may be disabled. */ }
                    const key = storedKey && /^[A-Za-z0-9._:-]{8,200}$/.test(storedKey) ? storedKey : crypto.randomUUID()
                    attempt.current = { storageKey, key }
                    try { sessionStorage.setItem(storageKey, key) } catch { /* In-memory retry still works. */ }
                }
                headers['Idempotency-Key'] = attempt.current.key
            }
            const res = await fetch('/api/orders', { method: 'POST', headers, body })
            const data = await res.json().catch(() => null) as OrderResponse | null

            if (!res.ok || data?.success !== true || typeof data.order_number !== 'string' || !data.order_number) {
                const unavailable = res.status === 404 || data?.code === 'ORDER_INTAKE_UNAVAILABLE'
                setSubmitError(unavailable
                    ? 'Chức năng đặt hàng tạm thời chưa khả dụng.'
                    : typeof data?.error === 'string' ? data.error : ORDER_ERROR)
                return
            }

            if (attempt.current) {
                try { sessionStorage.removeItem(attempt.current.storageKey) } catch { /* Storage may be disabled. */ }
                attempt.current = null
            }
            trackPurchase(
                data.order_number,
                !isolatedCheckout && typeof data.total === 'number' && Number.isFinite(data.total) ? data.total : total,
                items.map(item => ({
                    item_id: item.sku || item.productId.toString(),
                    item_name: item.name,
                    price: getCartUnitPrice(item) ?? 0,
                    quantity: item.quantity,
                    item_category: item.categorySlug,
                    item_brand: item.brandName || undefined,
                }))
            )

            // Preserve items changed from another cart control while this request was pending.
            useCartStore.setState(state => ({ items: state.items.filter(item => !items.includes(item)) }))
            if (isolatedCheckout) setOrderNumber(data.order_number)
            else router.push(`/dat-hang-thanh-cong?order=${encodeURIComponent(data.order_number)}`)
        } catch {
            setSubmitError('Không thể kết nối. Vui lòng kiểm tra mạng và thử lại.')
        } finally {
            submitting.current = false
            setIsSubmitting(false)
        }
    }

    if (orderNumber) {
        return (
            <section className="mx-auto max-w-xl px-5 py-16 text-center" role="status">
                <h1 className="text-2xl font-bold text-neutral-900">Đã nhận yêu cầu đặt hàng</h1>
                <p className="mt-3">Mã đơn hàng <strong className="break-all">{orderNumber}</strong></p>
                <p className="mt-2 text-neutral-600">Nhân viên sẽ liên hệ để xác nhận đơn hàng.</p>
                <Button asChild className="mt-6"><Link href="/">Tiếp tục mua hàng</Link></Button>
            </section>
        )
    }

    if (items.length === 0) {
        return (
            <div className="max-w-[1280px] mx-auto px-5 lg:px-8 py-16 flex flex-col items-center gap-6 text-center">
                <div className="w-24 h-24 bg-neutral-100 rounded-full flex items-center justify-center">
                    <ShoppingBag className="w-10 h-10 text-neutral-300" />
                </div>
                <div>
                    <h1 className="text-2xl font-bold text-neutral-900">Giỏ hàng trống</h1>
                    <p className="text-neutral-500 mt-2">Hãy thêm sản phẩm vào giỏ hàng để tiến hành đặt hàng.</p>
                </div>
                <Link href="/">
                    <Button className="bg-[#2E7A96] hover:bg-[#25617a] text-white gap-2">
                        <ArrowLeft className="w-4 h-4" />
                        Tiếp tục mua hàng
                    </Button>
                </Link>
            </div>
        )
    }

    return (
        <div className="max-w-[1280px] mx-auto px-5 lg:px-8 py-10">
            {/* Breadcrumb */}
            <div className="flex items-center gap-2 text-sm text-neutral-500 mb-8">
                <Link href="/" className="hover:text-[#2E7A96]">Trang chủ</Link>
                <span>/</span>
                <span className="text-neutral-900 font-medium">Giỏ hàng</span>
            </div>

            <h1 className="text-3xl font-bold text-neutral-900 mb-8">
                Giỏ hàng
                <span className="ml-3 text-lg font-normal text-neutral-400">
                    ({items.reduce((s, i) => s + i.quantity, 0)} sản phẩm)
                </span>
            </h1>

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-8">
                {/* Left: Items */}
                <fieldset disabled={isSubmitting} className="min-w-0 space-y-4">
                    {items.map((item) => (
                        <CartPageItem
                            key={item.cartItemId}
                            item={item}
                            requiresRefresh={isolatedCheckout && legacySanitaryLine(item)}
                            onRemove={() => removeItem(item.cartItemId)}
                            onQtyChange={(qty) => updateQuantity(item.cartItemId, qty)}
                        />
                    ))}

                    <div className="flex justify-between items-center pt-4">
                        <Link href="/" className="text-sm text-neutral-500 hover:text-[#2E7A96] flex items-center gap-1.5">
                            <ArrowLeft className="w-4 h-4" />
                            Tiếp tục mua hàng
                        </Link>
                        <button
                            onClick={handleClearCart}
                            className="text-sm text-red-400 hover:text-red-600 transition-colors"
                        >
                            Xóa toàn bộ
                        </button>
                    </div>
                </fieldset>

                {/* Right: Order Summary + Form */}
                <div className="space-y-6">
                    {/* Summary */}
                    <div className="bg-neutral-50 rounded-2xl border border-neutral-200 p-4 sm:p-6 space-y-4">
                        <h2 className="font-semibold text-neutral-900 text-lg">Tóm tắt đơn hàng</h2>

                        <div className="space-y-2 text-sm">
                            {items.map(item => {
                                const finalItemPrice = isolatedCheckout && legacySanitaryLine(item) ? null : getCartUnitPrice(item)
                                return (
                                    <div key={item.cartItemId} className="flex flex-col mb-2 last:mb-0">
                                        <div className="flex justify-between text-neutral-600">
                                            <span className="line-clamp-1 flex-1 mr-2">{item.name} × {item.quantity}</span>
                                            <span className="shrink-0 font-medium">
                                                {finalItemPrice ? formatPrice(finalItemPrice * item.quantity) : 'Liên hệ'}
                                            </span>
                                        </div>
                                        {(item.installOption === 'install' || item.installOption === 'replace' || (item.voucherPerUnit ?? item.onlineDiscountAmount ?? 0) > 0) && (
                                            <div className="flex flex-wrap gap-x-2 text-xs text-neutral-600">
                                                {item.installOption === 'install' && <span>+ Lắp đặt</span>}
                                                {item.installOption === 'replace' && <span>+ Tháo dỡ & Lắp đặt</span>}
                                                {(item.voucherPerUnit ?? 0) > 0 && (
                                                    <span>Voucher đã trừ −{formatPrice(item.voucherPerUnit! * item.quantity)}</span>
                                                )}
                                                {item.finalUnitPrice === undefined && (!isolatedCheckout || !legacySanitaryLine(item)) &&
                                                    (item.onlineDiscountAmount ?? 0) > 0 && <span>Có ưu đãi online tham khảo</span>}
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>

                        <div className="border-t border-neutral-200 pt-4 flex justify-between">
                            <span className="font-semibold text-neutral-900">Tổng cộng</span>
                            <span className="font-bold text-xl text-[#2E7A96]">
                                {total > 0 ? formatPrice(total) : 'Liên hệ'}
                            </span>
                        </div>

                        <p className="text-xs text-neutral-400">
                            Giá chưa bao gồm chi phí vận chuyển. Nhân viên sẽ liên hệ xác nhận đơn hàng.
                        </p>
                    </div>

                    {/* Customer Form */}
                    <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-neutral-200 p-4 sm:p-6">
                        <fieldset disabled={isSubmitting} className="min-w-0 space-y-4">
                            <h2 className="font-semibold text-neutral-900 text-lg">Thông tin đặt hàng</h2>

                            <div className="space-y-1">
                                <label htmlFor="customer-name" className="text-sm font-medium text-neutral-700">
                                    Họ và tên <span className="text-red-500">*</span>
                                </label>
                                <Input
                                    id="customer-name"
                                    autoComplete="name"
                                    placeholder="Nguyễn Văn A"
                                    required
                                    value={form.customer_name}
                                    onChange={e => setForm(f => ({ ...f, customer_name: e.target.value }))}
                                    className="h-11"
                                />
                            </div>

                            <div className="space-y-1">
                                <label htmlFor="customer-phone" className="text-sm font-medium text-neutral-700">
                                    Số điện thoại <span className="text-red-500">*</span>
                                </label>
                                <Input
                                    id="customer-phone"
                                    type="tel"
                                    inputMode="tel"
                                    autoComplete="tel"
                                    placeholder="0912 345 678"
                                    required
                                    value={form.customer_phone}
                                    onChange={e => setForm(f => ({ ...f, customer_phone: e.target.value }))}
                                    aria-invalid={phoneIsInvalid}
                                    aria-describedby={phoneIsInvalid ? 'customer-phone-error' : undefined}
                                    className="h-11"
                                />
                                {phoneIsInvalid && (
                                    <p id="customer-phone-error" className="text-xs text-red-600" role="alert">
                                        Nhập số di động Việt Nam, ví dụ 0912 345 678 hoặc +84 912 345 678.
                                    </p>
                                )}
                            </div>

                            <div className="space-y-1">
                                <label htmlFor="customer-email" className="text-sm font-medium text-neutral-700">Email</label>
                                <Input id="customer-email" autoComplete="email"
                                    type="email"
                                    placeholder="email@example.com"
                                    value={form.customer_email}
                                    onChange={e => setForm(f => ({ ...f, customer_email: e.target.value }))}
                                    className="h-11"
                                />
                            </div>

                            <div className="space-y-1">
                                <label htmlFor="customer-address" className="text-sm font-medium text-neutral-700">Địa chỉ nhận hàng</label>
                                <Input id="customer-address" autoComplete="street-address"
                                    placeholder="Số nhà, đường, phường/xã, tỉnh/thành"
                                    value={form.customer_address}
                                    onChange={e => setForm(f => ({ ...f, customer_address: e.target.value }))}
                                    className="h-11"
                                />
                            </div>

                            <div className="space-y-1">
                                <label htmlFor="customer-note" className="text-sm font-medium text-neutral-700">Ghi chú</label>
                                <Textarea id="customer-note"
                                    placeholder="Yêu cầu đặc biệt, thời gian giao hàng..."
                                    rows={3}
                                    value={form.note}
                                    onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                                    className="resize-none"
                                />
                            </div>

                            {orderBlocked && <p role="alert" className="text-sm text-red-700">
                                {needsRefresh
                                    ? 'Vui lòng thêm lại thiết bị vệ sinh từ trang sản phẩm để cập nhật giá.'
                                    : items.length > 20
                                        ? 'Mỗi đơn hàng hỗ trợ tối đa 20 dòng sản phẩm.'
                                        : 'Vui lòng xóa sản phẩm cần báo giá hoặc thêm lại sản phẩm thiếu mã SKU.'}
                            </p>}
                            {submitError && <p role="alert" className="text-sm text-red-700">{submitError}</p>}
                            <Button
                                type="submit"
                                disabled={isSubmitting || phoneIsInvalid || orderBlocked}
                                className="w-full h-12 bg-[#2E7A96] hover:bg-[#25617a] text-white font-semibold text-[15px] rounded-xl gap-2 mt-2"
                            >
                                {isSubmitting ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Đang xử lý...
                                    </>
                                ) : (
                                    'Xác nhận đặt hàng'
                                )}
                            </Button>

                            <p className="text-xs text-center text-neutral-500">
                                Bằng cách đặt hàng, bạn đồng ý với{' '}
                                <Link href="/chinh-sach-bao-mat" className="underline hover:text-[#2E7A96]">chính sách bảo mật</Link>
                                {' '}và{' '}
                                <Link href="/dieu-kien-giao-dich" className="underline hover:text-[#2E7A96]">điều kiện giao dịch</Link>.
                            </p>
                        </fieldset>
                    </form>
                </div>
            </div>
        </div>
    )
}

// ─── CartPageItem ─────────────────────────────────────────────────────────────

function CartPageItem({ item, requiresRefresh, onRemove, onQtyChange }: {
    item: CartItem
    requiresRefresh: boolean
    onRemove: () => void
    onQtyChange: (qty: number) => void
}) {
    const finalItemPrice = requiresRefresh ? null : getCartUnitPrice(item)
    return (
        <div className="flex gap-2.5 p-3 sm:gap-4 sm:p-4 bg-white border border-neutral-200 rounded-2xl">
            <div className="size-12 sm:size-20 rounded-xl border border-neutral-100 bg-neutral-50 overflow-hidden shrink-0">
                {item.imageUrl ? (
                    <Image src={item.imageUrl} alt={item.name} width={80} height={80} className="w-full h-full object-cover" />
                ) : (
                    <div className="w-full h-full flex items-center justify-center">
                        <Package2 className="w-7 h-7 text-neutral-300" />
                    </div>
                )}
            </div>

            <div className="flex-1 min-w-0">
                <p className="font-semibold text-neutral-900 line-clamp-2 text-sm leading-snug">{item.name}</p>
                {item.brandName && <p className="text-xs text-neutral-400 mt-0.5">{item.brandName}</p>}
                <p className="text-xs text-neutral-400 mt-0.5">SKU: {item.sku}</p>

                {/* Options display */}
                <div className="flex flex-col gap-0.5 mt-1.5">
                    {item.installOption === 'install' && (
                        <p className="text-[12px] text-sky-600 font-medium">+ Lắp đặt: {formatPrice(item.installationFee || 0)}</p>
                    )}
                    {item.installOption === 'replace' && (
                        <p className="text-[12px] text-sky-600 font-medium">+ Tháo dỡ & Lắp đặt: {formatPrice(item.installationFee || 0)}</p>
                    )}
                    {(item.voucherPerUnit ?? 0) > 0 && (
                        <p className="text-xs font-medium text-emerald-700">Voucher online −{formatPrice(item.voucherPerUnit!)} / sản phẩm</p>
                    )}
                    {!requiresRefresh && item.finalUnitPrice === undefined && (item.onlineDiscountAmount || 0) > 0 && (
                        <p className="text-[12px] text-emerald-600 font-medium">Ưu đãi online tham khảo: {formatPrice(item.onlineDiscountAmount || 0)}</p>
                    )}
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center border border-neutral-200 rounded-lg overflow-hidden h-9">
                        <button
                            type="button"
                            onClick={() => onQtyChange(item.quantity - 1)}
                            aria-label={`Giảm số lượng ${item.name}`}
                            className="w-9 h-full flex items-center justify-center bg-neutral-50 hover:bg-neutral-100 transition-colors"
                        >
                            <Minus className="w-3 h-3 text-neutral-600" />
                        </button>
                        <span className="w-10 text-center text-sm font-semibold border-x border-neutral-200">
                            {item.quantity}
                        </span>
                        <button
                            type="button"
                            onClick={() => onQtyChange(item.quantity + 1)}
                            aria-label={`Tăng số lượng ${item.name}`}
                            className="w-9 h-full flex items-center justify-center bg-neutral-50 hover:bg-neutral-100 transition-colors"
                        >
                            <Plus className="w-3 h-3 text-neutral-600" />
                        </button>
                    </div>

                    <div className="flex items-center gap-3">
                        <span className="font-bold text-[#2E7A96]">
                            {finalItemPrice ? formatPrice(finalItemPrice * item.quantity) : requiresRefresh ? 'Cần cập nhật giá' : 'Liên hệ'}
                        </span>
                        <button
                            type="button"
                            onClick={onRemove}
                            aria-label={`Xóa ${item.name} khỏi giỏ hàng`}
                            className="w-8 h-8 flex items-center justify-center text-neutral-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
