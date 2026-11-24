'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Minus, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { siteConfig } from '@/config/site'
import { formatPrice } from '@/lib/utils'
import { useCommerceCart } from '@/lib/commerce/cart-store'
import { attemptKey, checkCart, forgetAttempt, saveReceipt, submitOrder, submitQuote, type CartCheck, type CheckedLine, type Contact } from '@/lib/commerce/client'

const PHONE = /^(?:\+84|84|0)(?:3|5|7|8|9)\d{8}$/
const EMPTY: Contact = { customerName: '', customerPhone: '', customerEmail: '', deliveryAddress: '', note: '' }
const REASON: Record<string, string> = { NO_PRICE: 'Chưa có giá bán trực tuyến', QUOTE_ONLY: 'Sản phẩm chỉ bán theo báo giá' }

/** #470 commerce v1 cart + checkout. Prices and totals come ONLY from the server (cart check); a mixed cart is split into "Đặt hàng" and "Yêu cầu báo giá" — nothing is priced 0 or dropped silently. */
export function CommerceCartPage() {
    const router = useRouter()
    const { lines, setQuantity, remove, removeMany } = useCommerceCart()
    const [check, setCheck] = useState<CartCheck | null>(null)
    const [loading, setLoading] = useState(false)
    const [contact, setContact] = useState<Contact>(EMPTY)
    const [error, setError] = useState<string | null>(null)
    const [priceNotice, setPriceNotice] = useState(false)
    const [busy, setBusy] = useState<'order' | 'quote' | null>(null)
    const submitting = useRef(false)
    const signature = useMemo(() => JSON.stringify(lines.map(l => [l.productId, l.quantity])), [lines])

    const refresh = useCallback(async () => {
        if (lines.length === 0) { setCheck(null); return }
        setLoading(true)
        const result = await checkCart(lines)
        setLoading(false)
        if (result.ok) { setCheck({ lines: result.lines, order: result.order, quoteCount: result.quoteCount, unavailableCount: result.unavailableCount }); setError(null) }
        else setError(result.error)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [signature])
    useEffect(() => { void refresh() }, [refresh])

    const byId = useMemo(() => new Map<number, CheckedLine>((check?.lines ?? []).map(line => [line.productId, line])), [check])
    const orderLines = lines.filter(l => byId.get(l.productId)?.mode === 'order')
    const quoteLines = lines.filter(l => byId.get(l.productId)?.mode === 'quote')
    const unavailable = lines.filter(l => byId.get(l.productId)?.mode === 'unavailable')
    const set = (name: keyof Contact) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setContact(c => ({ ...c, [name]: event.target.value }))
    const phoneBad = contact.customerPhone.length > 0 && !PHONE.test(contact.customerPhone.replace(/[\s().-]/g, ''))

    async function send(kind: 'order' | 'quote') {
        if (submitting.current || !check) return
        const group = kind === 'order' ? orderLines : quoteLines
        if (group.length === 0) return
        if (contact.customerName.trim().length < 2) return setError('Vui lòng nhập họ tên.')
        if (!PHONE.test(contact.customerPhone.replace(/[\s().-]/g, ''))) return setError('Vui lòng nhập số điện thoại di động Việt Nam hợp lệ.')
        if (kind === 'order' && contact.deliveryAddress.trim().length < 5) return setError('Vui lòng nhập địa chỉ giao hàng.')
        submitting.current = true; setBusy(kind); setError(null); setPriceNotice(false)
        const payload = { kind, contact, lines: group.map(l => [l.productId, l.quantity]), expected: kind === 'order' ? check.order.totalVnd : 0 }
        const attempt = await attemptKey(kind, payload)
        const result = kind === 'order'
            ? await submitOrder(contact, group, check.order.totalVnd, attempt.key)
            : await submitQuote(contact, group, attempt.key)
        submitting.current = false; setBusy(null)
        if (result.ok) {
            forgetAttempt(attempt.storageKey)
            saveReceipt({ kind, code: result.code, status: result.status, totalVnd: result.totalVnd, subtotalVnd: result.subtotalVnd, voucherVnd: result.voucherVnd, lineCount: result.lineCount, at: Date.now() })
            removeMany(group.map(l => l.productId))
            router.push('/dat-hang-thanh-cong')
            return
        }
        if (result.code === 'PRICE_CHANGED') { setPriceNotice(true); await refresh() }
        else if (result.code === 'ITEMS_NOT_ORDERABLE' || result.code === 'PRODUCT_UNAVAILABLE') await refresh()
        if (result.code !== 'NETWORK') forgetAttempt(attempt.storageKey)
        setError(result.error)
    }

    if (lines.length === 0) {
        return (
            <section className="mx-auto max-w-3xl px-5 py-16 text-center">
                <h1 className="text-2xl font-bold text-stone-900">Giỏ hàng trống</h1>
                <p className="mt-3 text-stone-600">Thêm sản phẩm để đặt hàng hoặc yêu cầu báo giá.</p>
                <Button asChild className="mt-6 bg-brand-700 text-white hover:bg-brand-800"><Link prefetch={false} href="/thiet-bi-ve-sinh">Xem sản phẩm</Link></Button>
            </section>
        )
    }
    const money = (value: number) => formatPrice(value)
    return (
        <section className="mx-auto grid max-w-5xl gap-8 px-5 py-10 lg:grid-cols-[1fr_24rem]">
            <div className="grid content-start gap-4">
                <h1 className="text-2xl font-bold text-stone-900">Giỏ hàng</h1>
                {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
                {priceNotice && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Giá vừa thay đổi. Tổng tiền mới đã được cập nhật bên dưới — vui lòng kiểm tra rồi bấm gửi lại để xác nhận.</p>}
                <ul className="grid gap-3">
                    {lines.map(line => {
                        const info = byId.get(line.productId)
                        return (
                            <li key={line.productId} className="rounded-xl border border-stone-200 bg-white p-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <Link prefetch={false} className="font-semibold text-stone-900 hover:text-brand-700" href={`/${line.categorySlug}/${line.subcategorySlug ?? '-'}/${line.slug}`}>{line.name}</Link>
                                        <p className="text-sm text-stone-500">{line.sku}{line.brandName ? ` · ${line.brandName}` : ''}</p>
                                    </div>
                                    <button type="button" aria-label={`Xóa ${line.name}`} className="p-2 text-stone-500 hover:text-red-600" onClick={() => remove(line.productId)}><Trash2 className="h-5 w-5" aria-hidden="true" /></button>
                                </div>
                                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                                    <div className="flex items-center rounded-lg border border-stone-300">
                                        <button type="button" aria-label="Giảm số lượng" className="h-10 w-10" onClick={() => setQuantity(line.productId, line.quantity - 1)}><Minus className="mx-auto h-4 w-4" aria-hidden="true" /></button>
                                        <span aria-label="Số lượng" className="w-10 text-center">{line.quantity}</span>
                                        <button type="button" aria-label="Tăng số lượng" className="h-10 w-10" onClick={() => setQuantity(line.productId, line.quantity + 1)}><Plus className="mx-auto h-4 w-4" aria-hidden="true" /></button>
                                    </div>
                                    {info?.mode === 'order' && (
                                        <div className="text-right text-sm">
                                            {info.unitSellingVnd < info.regularVnd && <p className="text-stone-400 line-through">{money(info.regularVnd)}</p>}
                                            <p>{money(info.unitSellingVnd)} × {line.quantity}</p>
                                            {info.unitVoucherVnd > 0 && <p className="text-emerald-700">Voucher −{money(info.unitVoucherVnd * line.quantity)}</p>}
                                            <p className="font-semibold text-stone-900">{money(info.lineTotalVnd)}</p>
                                        </div>
                                    )}
                                    {info?.mode === 'quote' && <p className="text-sm font-medium text-brand-700">Yêu cầu báo giá · {REASON[info.reason] ?? 'Liên hệ báo giá'}</p>}
                                    {info?.mode === 'unavailable' && <p className="text-sm font-medium text-red-700">Sản phẩm không còn khả dụng — vui lòng xóa khỏi giỏ.</p>}
                                    {!info && loading && <Loader2 className="h-4 w-4 animate-spin text-stone-400" aria-label="Đang kiểm tra giá" />}
                                </div>
                            </li>
                        )
                    })}
                </ul>
                {unavailable.length > 0 && <Button type="button" variant="outline" onClick={() => removeMany(unavailable.map(l => l.productId))}>Xóa sản phẩm không còn khả dụng</Button>}
            </div>

            <aside className="grid content-start gap-6">
                <div className="grid gap-3 rounded-xl border border-stone-200 bg-stone-50 p-4">
                    <h2 className="font-semibold text-stone-900">Thông tin liên hệ</h2>
                    <label className="grid gap-1 text-sm">Họ tên<Input value={contact.customerName} onChange={set('customerName')} autoComplete="name" maxLength={120} /></label>
                    <label className="grid gap-1 text-sm">Số điện thoại<Input value={contact.customerPhone} onChange={set('customerPhone')} inputMode="tel" autoComplete="tel" aria-invalid={phoneBad} />
                        {phoneBad && <span className="text-red-700">Số điện thoại chưa hợp lệ.</span>}</label>
                    <label className="grid gap-1 text-sm">Email (không bắt buộc)<Input value={contact.customerEmail} onChange={set('customerEmail')} type="email" autoComplete="email" maxLength={200} /></label>
                    {orderLines.length > 0 && <label className="grid gap-1 text-sm">Địa chỉ giao hàng<Textarea value={contact.deliveryAddress} onChange={set('deliveryAddress')} rows={2} maxLength={400} /></label>}
                    <label className="grid gap-1 text-sm">Ghi chú<Textarea value={contact.note} onChange={set('note')} rows={2} maxLength={1000} /></label>
                </div>

                {orderLines.length > 0 && check && (
                    <div className="grid gap-3 rounded-xl border border-brand-200 p-4" aria-label="Đặt hàng">
                        <h2 className="font-semibold text-stone-900">Đặt hàng ({orderLines.length} sản phẩm)</h2>
                        <dl className="grid gap-1 text-sm">
                            <div className="flex justify-between"><dt>Tạm tính</dt><dd>{money(check.order.subtotalVnd)}</dd></div>
                            {check.order.voucherVnd > 0 && <div className="flex justify-between text-emerald-700"><dt>Voucher</dt><dd>−{money(check.order.voucherVnd)}</dd></div>}
                            <div className="flex justify-between text-base font-bold text-stone-900"><dt>Tổng cộng</dt><dd>{money(check.order.totalVnd)}</dd></div>
                        </dl>
                        <p className="text-xs text-stone-500">Chưa gồm phí vận chuyển/lắp đặt. Đây là đơn đặt hàng gửi Đông Phú Gia — <strong>chưa phải thanh toán</strong> và chưa đảm bảo tồn kho. Nhân viên sẽ liên hệ xác nhận tồn kho, giao hàng, chi phí và hình thức thanh toán.</p>
                        <Button type="button" disabled={busy !== null || loading} onClick={() => void send('order')} className="h-12 bg-brand-700 text-white hover:bg-brand-800">
                            {busy === 'order' ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}{priceNotice ? 'Xác nhận và gửi đơn hàng' : 'Gửi đơn đặt hàng'}
                        </Button>
                    </div>
                )}

                {quoteLines.length > 0 && check && (
                    <div className="grid gap-3 rounded-xl border border-stone-300 p-4" aria-label="Yêu cầu báo giá">
                        <h2 className="font-semibold text-stone-900">Yêu cầu báo giá ({quoteLines.length} sản phẩm)</h2>
                        <p className="text-xs text-stone-500">Các sản phẩm này chưa có giá bán trực tuyến. Nhân viên sẽ gửi báo giá cho bạn.</p>
                        <Button type="button" disabled={busy !== null || loading} onClick={() => void send('quote')} variant="outline" className="h-12 border-brand-700 text-brand-700">
                            {busy === 'quote' ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}Gửi yêu cầu báo giá
                        </Button>
                    </div>
                )}
                {orderLines.length > 0 && quoteLines.length > 0 && <p className="text-xs text-stone-500">Giỏ hàng có cả sản phẩm đặt mua và sản phẩm cần báo giá: hai phần được gửi riêng, mỗi phần có mã riêng.</p>}
                <p className="text-sm text-stone-600">Cần hỗ trợ? Gọi <a className="font-semibold text-brand-700" href={`tel:${siteConfig.contact.hotline}`}>{siteConfig.contact.hotlineLabel}</a>.</p>
            </aside>
        </section>
    )
}
