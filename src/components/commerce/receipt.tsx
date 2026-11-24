'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { siteConfig } from '@/config/site'
import { formatPrice } from '@/lib/utils'
import { loadReceipts, type Receipt } from '@/lib/commerce/client'
import { useCommerceCart } from '@/lib/commerce/cart-store'

/** #470 commerce v1 receipt: shows the codes the server issued in THIS browser session (no server lookup, no personal data on the page). A receipt is NOT a payment and NOT a stock guarantee. */
export function CommerceReceipt() {
    const [receipts, setReceipts] = useState<Receipt[] | null>(null)
    const remaining = useCommerceCart(state => state.lines.length)
    // Receipts live only in this browser session (sessionStorage): read after mount to keep SSR/hydration identical.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { setReceipts(loadReceipts()) }, [])
    if (receipts === null) return null
    if (receipts.length === 0) {
        return (
            <section className="mx-auto max-w-lg px-5 py-16 text-center">
                <h1 className="text-2xl font-bold text-stone-900">Không có biên nhận trong phiên này</h1>
                <p className="mt-3 text-stone-600">Nếu bạn vừa gửi đơn hoặc yêu cầu, nhân viên Đông Phú Gia sẽ liên hệ qua số điện thoại bạn đã cung cấp. Cần hỗ trợ gọi {siteConfig.contact.hotlineLabel}.</p>
                <Button asChild className="mt-6 bg-brand-700 text-white hover:bg-brand-800"><Link prefetch={false} href="/">Về trang chủ</Link></Button>
            </section>
        )
    }
    return (
        <section className="mx-auto max-w-lg px-5 py-12 text-center">
            <CheckCircle2 className="mx-auto h-14 w-14 text-emerald-600" aria-hidden="true" />
            <h1 className="mt-4 text-2xl font-bold text-stone-900">Đông Phú Gia đã nhận được yêu cầu của bạn</h1>
            <ul className="mt-6 grid gap-4 text-left">
                {receipts.map(receipt => (
                    <li key={receipt.code} className="rounded-xl border border-stone-200 p-4">
                        <p className="text-sm text-stone-500">{receipt.kind === 'order' ? 'Đơn đặt hàng' : 'Yêu cầu báo giá'}</p>
                        <p className="text-xl font-bold tracking-wide text-stone-900" data-testid="receipt-code">{receipt.code}</p>
                        {receipt.kind === 'order' && receipt.totalVnd !== undefined && <p className="text-sm text-stone-700">Tổng cộng: <strong>{formatPrice(receipt.totalVnd)}</strong> · {receipt.lineCount} sản phẩm</p>}
                        {receipt.kind === 'quote' && <p className="text-sm text-stone-700">{receipt.lineCount} sản phẩm</p>}
                    </li>
                ))}
            </ul>
            <p className="mt-6 text-sm text-stone-600">Mã trên là <strong>biên nhận đã nhận yêu cầu</strong>, chưa phải thanh toán và chưa đảm bảo tồn kho. Nhân viên sẽ liên hệ xác nhận giao hàng, chi phí và thanh toán. Vui lòng giữ mã để tra cứu khi liên hệ {siteConfig.contact.hotlineLabel}.</p>
            <div className="mt-6 flex justify-center gap-3">
                {remaining > 0 && <Button asChild variant="outline"><Link prefetch={false} href="/gio-hang">Quay lại giỏ hàng</Link></Button>}
                <Button asChild className="bg-brand-700 text-white hover:bg-brand-800"><Link prefetch={false} href="/">Về trang chủ</Link></Button>
            </div>
        </section>
    )
}
