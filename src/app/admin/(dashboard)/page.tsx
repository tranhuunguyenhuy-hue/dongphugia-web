import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowUpRight, ClipboardList, Package2, ShoppingCart, TrendingUp } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/admin/page-header'
import { can } from '@/lib/auth/permissions'
import { getCurrentUser, requirePermission } from '@/lib/auth/get-current-user'
import { getDashboardStats } from '@/lib/admin-dashboard-queries'

function formatVND(amount: number) {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(amount)
}

export default async function AdminDashboardPage() {
    const user = await getCurrentUser()
    if (!user) redirect('/admin/login')
    if (!can(user.role, 'dashboard:read')) redirect('/admin/products')
    await requirePermission('dashboard:read')

    const stats = await getDashboardStats()
    const cards = [
        {
            title: 'Sản phẩm đang hoạt động',
            value: stats.activeProducts.toLocaleString('vi-VN'),
            detail: `${stats.totalProducts.toLocaleString('vi-VN')} sản phẩm trong danh mục`,
            href: '/admin/products',
            icon: Package2,
        },
        {
            title: 'Yêu cầu báo giá chờ xử lý',
            value: stats.pendingQuotes.toLocaleString('vi-VN'),
            detail: 'Mở danh sách yêu cầu báo giá',
            href: '/admin/quote-requests',
            icon: ClipboardList,
        },
        {
            title: 'Đơn hàng chờ xử lý',
            value: stats.pendingOrders.toLocaleString('vi-VN'),
            detail: 'Mở danh sách đơn hàng',
            href: '/admin/orders',
            icon: ShoppingCart,
        },
        {
            title: 'Doanh thu tháng này',
            value: formatVND(stats.revenueThisMonth),
            detail: `${stats.ordersThisMonth.toLocaleString('vi-VN')} đơn đã giao và thanh toán`,
            href: '/admin/orders',
            icon: TrendingUp,
        },
    ]

    return (
        <div className="space-y-6">
            <PageHeader title="Dashboard" description="Tổng quan hệ thống quản lý Đông Phú Gia" />
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {cards.map(({ title, value, detail, href, icon: Icon }) => (
                    <Link href={href} key={title} className="group">
                        <Card className="h-full transition-colors group-hover:border-primary/40">
                            <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                                <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
                                <Icon className="size-4 text-muted-foreground" />
                            </CardHeader>
                            <CardContent>
                                <div className="text-2xl font-semibold tabular-nums">{value}</div>
                                <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                                    {detail}
                                    <ArrowUpRight className="size-3 shrink-0" />
                                </p>
                            </CardContent>
                        </Card>
                    </Link>
                ))}
            </div>
        </div>
    )
}
