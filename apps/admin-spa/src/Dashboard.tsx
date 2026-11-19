import { useEffect, useState, type ReactNode } from 'react'
import { ArrowDownRight, ArrowUpRight, FileQuestion, Package, ShoppingCart, Wallet } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { commerce, errorText, type Dashboard } from './api'
import { PAYMENT_STATUS } from './Commerce'
import { Alert, NativeSelect, PageHeader, money } from './ui'

const BASE = '/admin-next'
const dateText = (value: string) => new Date(value).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })
const PERIODS: [string, string][] = [['day', '30 ngày'], ['week', '12 tuần'], ['month', '12 tháng'], ['year', '5 năm']]

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

export function DashboardPage({ go }: { go: (to: string) => void }) {
  const [period, setPeriod] = useState('month'); const [data, setData] = useState<Dashboard | null>(null); const [error, setError] = useState('')
  useEffect(() => { let live = true; commerce.dashboard(period).then((d) => { if (live) { setData(d); setError('') } }).catch((e) => { if (live) setError(errorText(e)) }); return () => { live = false } }, [period])
  const link = (to: string, label: ReactNode) => <a className="font-medium hover:underline" href={BASE + to} onClick={(e) => { e.preventDefault(); go(to) }}>{label}</a>
  const header = <PageHeader title="Tổng quan" description="Số liệu thực từ đơn hàng, báo giá và sản phẩm." actions={<NativeSelect aria-label="Kỳ doanh thu" className="w-36" value={period} onChange={(e) => setPeriod(e.target.value)}>{PERIODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>} />
  if (!data) return <div className="grid grid-cols-[minmax(0,1fr)] gap-6">{header}{error ? <Alert>{error}</Alert> : <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 rounded-xl" />)}</div>}</div>
  const s = data.stats; const max = Math.max(1, ...data.revenue.map((r) => r.revenue)); const growth = s.revenue_growth
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      {header}
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi title="Báo giá chờ xử lý" value={s.pending_quotes} icon={<FileQuestion />} />
        <Kpi title="Đơn hàng chờ xử lý" value={s.pending_orders} icon={<ShoppingCart />} />
        <Kpi title="Doanh thu tháng này" value={money(s.revenue_this_month)} icon={<Wallet />} hint={<span className="inline-flex items-center gap-1">{growth === null ? 'Chưa có dữ liệu tháng trước' : <>{growth >= 0 ? <ArrowUpRight className="size-3.5 text-success" /> : <ArrowDownRight className="size-3.5 text-destructive" />}{growth >= 0 ? '+' : ''}{growth}% so với tháng trước</>} · {s.orders_this_month} đơn</span>} />
        <Kpi title="Sản phẩm đang bán" value={<>{s.active_products}<span className="text-base font-normal text-muted-foreground"> / {s.total_products}</span></>} icon={<Package />} />
      </div>
      <Card>
        <CardHeader><CardTitle>Doanh thu</CardTitle><CardDescription>Đơn hoàn thành và đã thanh toán, theo kỳ đã chọn.</CardDescription></CardHeader>
        <CardContent>
          {data.revenue.length ? (
            <div className="grid gap-2">
              <div className="flex h-44 items-end gap-1 border-b" role="img" aria-label="Biểu đồ doanh thu">
                {data.revenue.map((r) => <div key={r.date} className="flex h-full flex-1 items-end" title={`${new Date(r.date).toLocaleDateString('vi-VN')}: ${money(r.revenue)} (${r.order_count} đơn)`}><div className="w-full rounded-t-sm bg-primary/85 transition-colors hover:bg-primary" style={{ height: `${Math.max(2, (r.revenue / max) * 100)}%` }} /></div>)}
              </div>
              <div className="flex justify-between text-xs text-muted-foreground"><span>{new Date(data.revenue[0].date).toLocaleDateString('vi-VN')}</span><span>Cao nhất: {money(max)}</span><span>{new Date(data.revenue[data.revenue.length - 1].date).toLocaleDateString('vi-VN')}</span></div>
            </div>
          ) : <p className="py-10 text-center text-sm text-muted-foreground">Chưa có đơn hoàn thành đã thanh toán trong kỳ.</p>}
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Báo giá chờ xử lý</CardTitle></CardHeader><CardContent>
          <Rows empty="Không có báo giá chờ xử lý.">{data.pending_quotes.map((q) => <li key={q.id} className="flex items-start justify-between gap-3 py-2.5 text-sm"><div className="min-w-0">{link(`/quotes/${q.id}`, q.quote_number ?? `#${q.id}`)} <span className="text-muted-foreground">· {q.name} · {q.phone}</span><p className="truncate text-xs text-muted-foreground">{q.item_names || '—'}</p></div><span className="shrink-0 text-xs text-muted-foreground">{dateText(q.created_at)}</span></li>)}</Rows>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Đơn hàng chờ xử lý</CardTitle></CardHeader><CardContent>
          <Rows empty="Không có đơn chờ xử lý.">{data.pending_orders.map((o) => <li key={o.id} className="flex items-start justify-between gap-3 py-2.5 text-sm"><div className="min-w-0">{link(`/orders/${o.id}`, o.order_number)} <span className="text-muted-foreground">· {o.customer_name}</span><p className="text-xs text-muted-foreground">{money(o.total)} · {dateText(o.created_at)}</p></div><Badge variant={o.payment_status === 'paid' ? 'secondary' : 'outline'}>{PAYMENT_STATUS[o.payment_status] ?? o.payment_status}</Badge></li>)}</Rows>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Sản phẩm bán chạy</CardTitle></CardHeader><CardContent>
          <Rows empty="Chưa có dữ liệu.">{data.top_sold.map((p) => <li key={p.product_id} className="flex items-center justify-between gap-3 py-2.5 text-sm"><span className="min-w-0 truncate">{p.product_name} <span className="text-muted-foreground">({p.product_sku})</span></span><span className="shrink-0 font-medium tabular-nums">{p.total_sold}</span></li>)}</Rows>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Được báo giá nhiều</CardTitle></CardHeader><CardContent>
          <Rows empty="Chưa có dữ liệu.">{data.top_quoted.map((p) => <li key={p.product_id} className="flex items-center justify-between gap-3 py-2.5 text-sm"><span className="min-w-0 truncate">{p.name} <span className="text-muted-foreground">({p.sku})</span></span><span className="shrink-0 font-medium tabular-nums">{p.quote_count} lần</span></li>)}</Rows>
        </CardContent></Card>
      </div>
    </div>
  )
}
