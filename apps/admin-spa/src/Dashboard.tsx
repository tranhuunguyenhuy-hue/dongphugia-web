import { useEffect, useState, type ReactNode } from 'react'
import { FileQuestion, Package, ShoppingCart } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { commerce, errorText, type Dashboard } from './api'
import { Alert, PageHeader, money } from './ui'

const BASE = '/admin-next'
const dateText = (value: string) => new Date(value).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })

function Kpi({ title, value, hint, icon }: { title: string; value: ReactNode; hint?: ReactNode; icon: ReactNode }) {
  return (
    <Card className="gap-2 py-4">
      <div className="flex items-center justify-between gap-2 px-6"><CardDescription>{title}</CardDescription><span className="text-muted-foreground [&_svg]:size-4">{icon}</span></div>
      <CardContent><div className="text-2xl font-semibold tracking-tight">{value}</div>{hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}</CardContent>
    </Card>
  )
}
function Rows({ empty, children }: { empty: string; children: ReactNode[] }) {
  return children.length ? <ul className="divide-y">{children}</ul> : <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
}

/** Commerce v1 overview: what is waiting for staff. No revenue/payment figures — payment is confirmed outside the system. */
export function DashboardPage({ go }: { go: (to: string) => void }) {
  const [data, setData] = useState<Dashboard | null>(null); const [error, setError] = useState('')
  useEffect(() => { let live = true; commerce.dashboard().then((d) => { if (live) { setData(d); setError('') } }).catch((e) => { if (live) setError(errorText(e)) }); return () => { live = false } }, [])
  const link = (to: string, label: ReactNode) => <a className="font-medium hover:underline" href={BASE + to} onClick={(e) => { e.preventDefault(); go(to) }}>{label}</a>
  const header = <PageHeader title="Tổng quan" description="Đơn hàng và yêu cầu báo giá đang chờ xử lý, quy mô danh mục sản phẩm." />
  if (!data) return <div className="grid grid-cols-[minmax(0,1fr)] gap-6">{header}{error ? <Alert>{error}</Alert> : <div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>}</div>
  const s = data.stats
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      {header}
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-3">
        <Kpi title="Đơn hàng mới" value={s.new_orders} hint={`${s.processing_orders} đang xử lý`} icon={<ShoppingCart />} />
        <Kpi title="Yêu cầu báo giá mới" value={s.new_quotes} hint={`${s.processing_quotes} đang xử lý`} icon={<FileQuestion />} />
        <Kpi title="Sản phẩm đang bán" value={<>{s.active_products}<span className="text-base font-normal text-muted-foreground"> / {s.total_products}</span></>} icon={<Package />} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Đơn hàng mới</CardTitle></CardHeader><CardContent>
          <Rows empty="Không có đơn hàng mới.">{data.new_orders.map((o) => <li key={o.id} className="flex items-start justify-between gap-3 py-2.5 text-sm"><div className="min-w-0">{link(`/orders/${o.id}`, o.code)} <span className="text-muted-foreground">· {o.customer_name} · {o.customer_phone}</span><p className="text-xs text-muted-foreground">{money(o.total_vnd)} · {o.line_count} sản phẩm</p></div><span className="shrink-0 text-xs text-muted-foreground">{dateText(o.created_at)}</span></li>)}</Rows>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Yêu cầu báo giá mới</CardTitle></CardHeader><CardContent>
          <Rows empty="Không có yêu cầu báo giá mới.">{data.new_quotes.map((q) => <li key={q.id} className="flex items-start justify-between gap-3 py-2.5 text-sm"><div className="min-w-0">{link(`/quotes/${q.id}`, q.code)} <span className="text-muted-foreground">· {q.customer_name} · {q.customer_phone}</span><p className="text-xs text-muted-foreground">{q.line_count} sản phẩm</p></div><span className="shrink-0 text-xs text-muted-foreground">{dateText(q.created_at)}</span></li>)}</Rows>
        </CardContent></Card>
      </div>
    </div>
  )
}
