// Orders and quote requests (dedicated function handlers). Totals shown here are previews: the server recomputes them
// from the stored lines on save. Built on the shared shadcn-style primitives; the A4 print sheet keeps its own styles.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, Printer, Save, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { ApiError, can, commerce, errorText, type OrderDetail, type OrderRow, type QuoteDetail, type QuoteRow, type User } from './api'
import { Alert, CTA, EmptyState, NativeSelect, PageHeader, SkeletonRows, money, toast, useConfirm } from './ui'

const BASE = '/admin-next'
type Go = (to: string) => void
const dateText = (value: string) => new Date(value).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })
const Link = ({ to, go, children }: { to: string; go: Go; children: ReactNode }) => <a className="font-medium hover:underline" href={BASE + to} onClick={(e) => { e.preventDefault(); go(to) }}>{children}</a>

export const ORDER_STATUS: Record<string, string> = { pending: 'Chờ xử lý', received: 'Đã tiếp nhận', confirmed: 'Đã xác nhận', inventory_check: 'Kiểm tra kho', completed: 'Hoàn thành', cancelled: 'Đã huỷ' }
export const PAYMENT_STATUS: Record<string, string> = { unpaid: 'Chưa thanh toán', paid: 'Đã thanh toán', refunded: 'Đã hoàn tiền' }
export const QUOTE_STATUS: Record<string, string> = { pending: 'Chờ xử lý', resolved: 'Đang làm báo giá', completed: 'Hoàn thành', cancelled: 'Đã huỷ' }
const statusTone = (status: string): 'secondary' | 'outline' | 'destructive' => (status === 'completed' ? 'secondary' : status === 'cancelled' ? 'destructive' : 'outline')

function useAssignees(enabled: boolean) {
  const [list, setList] = useState<{ id: number; name: string; role: string }[]>([])
  useEffect(() => { if (enabled) commerce.assignees().then(setList).catch(() => setList([])) }, [enabled])
  return list
}

function Assign({ value, users, onChange, disabled }: { value: number | null; users: { id: number; name: string }[]; onChange: (id: number | null) => void; disabled?: boolean }) {
  return <NativeSelect aria-label="Giao cho" className="min-w-36" disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}><option value="">Chưa giao</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</NativeSelect>
}

function Pager({ page, pages, setPage, total }: { page: number; pages: number; setPage: (n: number) => void; total: number }) {
  const first = total === 0 ? 0 : (page - 1) * 20 + 1; const last = Math.min(total, page * 20)
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-sm">
      <span className="text-muted-foreground">{total ? `Hiển thị ${first}–${last} / ${total}` : ' '}</span>
      <div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft />Trước</Button><span className="text-muted-foreground tabular-nums">Trang {page}/{pages}</span><Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Sau<ChevronRight /></Button></div>
    </div>
  )
}

const SearchBox = ({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string; onChange: (v: string) => void }) => (
  <div className="relative min-w-52 flex-1 sm:max-w-sm"><Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" /><Input type="search" aria-label={label} placeholder={placeholder} className="pl-8" value={value} onChange={(e) => onChange(e.target.value)} /></div>
)

export function OrdersList({ user, go }: { user: User; go: Go }) {
  const [q, setQ] = useState(''); const [term, setTerm] = useState(''); const [status, setStatus] = useState(''); const [payment, setPayment] = useState(''); const [page, setPage] = useState(1)
  const [data, setData] = useState<{ items: OrderRow[]; total: number; stats: { total: number; pending: number; processing: number; completed: number; revenue: number } } | null>(null)
  const [error, setError] = useState(''); const [reload, setReload] = useState(0); const assignees = useAssignees(can(user, 'orders:assign'))
  useEffect(() => { const t = setTimeout(() => { setTerm(q.trim()); setPage(1) }, 300); return () => clearTimeout(t) }, [q])
  useEffect(() => { let live = true; commerce.orders({ q: term, status, payment_status: payment, page, limit: 20 }).then((d) => { if (live) { setData(d); setError('') } }).catch((e) => { if (live) setError(errorText(e)) }); return () => { live = false } }, [term, status, payment, page, reload])
  const act = async (run: () => Promise<unknown>) => { try { await run(); setReload((n) => n + 1); toast.success('Đã cập nhật.') } catch (e) { setError(errorText(e)) } }
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 20))
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <PageHeader title="Đơn hàng" description={data ? `${data.total} đơn` : undefined} />
      {data && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[['Tổng đơn', data.stats.total], ['Chờ xử lý', data.stats.pending], ['Đang xử lý', data.stats.processing], ['Hoàn thành', data.stats.completed]].map(([label, value]) => <Card key={String(label)} className="gap-1 py-3"><CardHeader className="px-4 pb-0"><span className="text-sm text-muted-foreground">{label}</span></CardHeader><CardContent className="px-4 text-2xl font-semibold tabular-nums">{value}</CardContent></Card>)}
      </div>}
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <SearchBox label="Tìm đơn hàng" placeholder="Mã đơn, tên, số điện thoại" value={q} onChange={setQ} />
          <NativeSelect aria-label="Trạng thái" className="w-44" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}><option value="">Trạng thái: tất cả</option>{Object.entries(ORDER_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect>
          <NativeSelect aria-label="Thanh toán" className="w-48" value={payment} onChange={(e) => { setPayment(e.target.value); setPage(1) }}><option value="">Thanh toán: tất cả</option>{Object.entries(PAYMENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect>
        </div>
        {error && <div className="p-3"><Alert>{error}</Alert></div>}
        <Table className="min-w-[860px]">
          <TableHeader className="bg-muted/40"><TableRow className="hover:bg-transparent"><TableHead>Mã đơn</TableHead><TableHead>Khách hàng</TableHead><TableHead>Tổng</TableHead><TableHead>Trạng thái</TableHead><TableHead>Thanh toán</TableHead><TableHead>Phụ trách</TableHead><TableHead>Ngày</TableHead></TableRow></TableHeader>
          <TableBody>
            {!data && <SkeletonRows rows={6} cols={7} />}
            {data?.items.map((o) => (
              <TableRow key={o.id}>
                <TableCell><Link to={`/orders/${o.id}`} go={go}>{o.order_number}</Link></TableCell>
                <TableCell>{o.customer_name}<p className="text-xs text-muted-foreground">{o.customer_phone}</p></TableCell>
                <TableCell className="tabular-nums">{money(o.total)}</TableCell>
                <TableCell><NativeSelect aria-label={`Trạng thái ${o.order_number}`} className="min-w-36" disabled={!can(user, 'orders:update_status')} value={o.status} onChange={(e) => act(() => commerce.orderStatus(o.id, e.target.value))}>{Object.entries(ORDER_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></TableCell>
                <TableCell><Badge variant={o.payment_status === 'paid' ? 'secondary' : 'outline'}>{PAYMENT_STATUS[o.payment_status] ?? o.payment_status}</Badge></TableCell>
                <TableCell>{can(user, 'orders:assign') ? <Assign value={o.assigned_to} users={assignees} onChange={(id) => act(() => commerce.orderAssign(o.id, id))} /> : o.assigned_name ?? '—'}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{dateText(o.created_at)}</TableCell>
              </TableRow>))}
          </TableBody>
        </Table>
        {data && !data.items.length && <EmptyState title="Không có đơn hàng" hint={term || status || payment ? 'Thử đổi từ khóa hoặc bộ lọc.' : undefined} />}
        <Pager page={page} pages={pages} setPage={setPage} total={data?.total ?? 0} />
      </Card>
    </div>
  )
}

type LineDraft = { id: number; name: string; sku: string; unit_price: number; quantity: number }
const lineTotal = (l: { unit_price: number; quantity: number }) => (Number.isFinite(l.unit_price) && Number.isFinite(l.quantity) ? l.unit_price * l.quantity : 0)

function Totals({ subtotal, vat, shipping, discount, plain = false }: { subtotal: number; vat: number; shipping: number; discount?: number; plain?: boolean }) {
  const vatAmount = subtotal * vat / 100; const total = subtotal + vatAmount + shipping - (discount ?? 0)
  const row = (label: string, value: string, strong = false) => <div className={cn('flex justify-between py-0.5 text-sm', strong && 'mt-1 border-t pt-2 text-base font-semibold')}><span className={strong || plain ? undefined : 'text-muted-foreground'}>{label}</span><span className="tabular-nums">{value}</span></div>
  return <div>{row('Tạm tính', money(subtotal))}{row(`VAT (${vat}%)`, money(vatAmount))}{row('Phí vận chuyển', money(shipping))}{discount !== undefined && row('Giảm giá', `−${money(discount)}`)}{row('Tổng cộng', money(total), true)}</div>
}

/* A4 sheet: print layout styles live in legacy.css under `.legacy` (kept on purpose, they mirror the printed document). */
function Print({ title, customer, lines, vat, shipping, discount, notes }: { title: string; customer: { name: string; phone: string; email: string | null; code: string }; lines: LineDraft[]; vat: number; shipping: number; discount?: number; notes: string }) {
  const subtotal = lines.reduce((sum, l) => sum + lineTotal(l), 0); const today = new Date()
  return (
    <div className="a4">
      <div className="a4-head"><h2>ĐÔNG PHÚ GIA</h2><p><strong>CÔNG TY TNHH ĐÔNG PHÚ GIA</strong></p><p>Hotline: 0913 865 685 · Phòng KD: 0855 528 688</p><p>Địa chỉ: 273–275 Phan Đình Phùng, Phường 2, Đà Lạt, Lâm Đồng</p></div>
      <h3 className="a4-title">{title}</h3><p className="center-text"><em>Ngày {today.getDate()} tháng {today.getMonth() + 1} năm {today.getFullYear()}</em></p>
      <div className="a4-cols"><div><p><strong>Khách hàng:</strong> {customer.name}</p><p><strong>Điện thoại:</strong> {customer.phone}</p></div><div><p><strong>Email:</strong> {customer.email || '—'}</p><p><strong>Mã:</strong> {customer.code}</p></div></div>
      <table><thead><tr><th>STT</th><th>Tên sản phẩm</th><th>SL</th><th>Đơn giá</th><th>Thành tiền</th></tr></thead>
        <tbody>{lines.map((l, i) => <tr key={l.id}><td>{i + 1}</td><td>{l.name}{l.sku && <><br /><small>Mã: {l.sku}</small></>}</td><td>{l.quantity}</td><td>{money(l.unit_price)}</td><td>{money(lineTotal(l))}</td></tr>)}</tbody></table>
      <Totals subtotal={subtotal} vat={vat} shipping={shipping} discount={discount} plain />
      {notes && <><p><strong>Ghi chú:</strong></p><p className="pre">{notes}</p></>}
      <div className="a4-sign"><div><strong>Khách hàng</strong><br /><em>(Ký, ghi rõ họ tên)</em></div><div><strong>Đại diện kinh doanh</strong><br /><em>(Ký, ghi rõ họ tên)</em><div className="sign-space" /><span>Đông Phú Gia</span></div></div>
    </div>
  )
}


const num = (value: string) => (value === '' ? NaN : Number(value))
const NumberField = ({ label, value, onChange, disabled, min = 0, max, step }: { label: string; value: number; onChange: (n: number) => void; disabled: boolean; min?: number; max?: number; step?: number }) => (
  <Label className="grid content-start gap-2">{label}<Input type="number" min={min} max={max} step={step} disabled={disabled} value={Number.isNaN(value) ? '' : value} onChange={(e) => onChange(num(e.target.value))} /></Label>
)

function LinesTable({ lines, setLines, disabled }: { lines: LineDraft[]; setLines: (lines: LineDraft[]) => void; disabled: boolean }) {
  return (
    <div className="overflow-x-auto rounded-md border"><Table className="min-w-[520px]">
      <TableHeader className="bg-muted/40"><TableRow className="hover:bg-transparent"><TableHead>Sản phẩm</TableHead><TableHead className="w-32">Đơn giá</TableHead><TableHead className="w-20">SL</TableHead><TableHead className="w-32 text-right">Thành tiền</TableHead></TableRow></TableHeader>
      <TableBody>
        {lines.map((l, i) => (
          <TableRow key={l.id}>
            <TableCell className="whitespace-normal">{l.name}<p className="text-xs text-muted-foreground">{l.sku}</p></TableCell>
            <TableCell><Input aria-label={`Đơn giá ${l.name}`} type="number" min={0} disabled={disabled} value={Number.isNaN(l.unit_price) ? '' : l.unit_price} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unit_price: num(e.target.value) } : x)))} /></TableCell>
            <TableCell><Input aria-label={`Số lượng ${l.name}`} type="number" min={1} step={1} disabled={disabled} value={Number.isNaN(l.quantity) ? '' : l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: num(e.target.value) } : x)))} /></TableCell>
            <TableCell className="text-right tabular-nums">{money(lineTotal(l))}</TableCell>
          </TableRow>))}
      </TableBody>
    </Table></div>
  )
}

const DetailSkeleton = ({ error }: { error: string }) => (error ? <Alert>{error}</Alert> : <div className="grid gap-4"><Skeleton className="h-9 w-64" /><Skeleton className="h-80 rounded-xl" /></div>)

export function OrderDetailPage({ id, user, go }: { id: number; user: User; go: Go }) {
  const [order, setOrder] = useState<OrderDetail | null>(null); const [lines, setLines] = useState<LineDraft[]>([]); const [vat, setVat] = useState(0); const [shipping, setShipping] = useState(0); const [discount, setDiscount] = useState(0); const [note, setNote] = useState('')
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const assignees = useAssignees(can(user, 'orders:assign')); const canEdit = can(user, 'orders:edit')
  const apply = useCallback((o: OrderDetail) => { setOrder(o); setLines(o.items.map((i) => ({ id: i.id, name: i.product_name, sku: i.product_sku, unit_price: Number(i.unit_price ?? 0), quantity: i.quantity }))); setVat(o.vat_rate); setShipping(Number(o.shipping_fee ?? 0)); setDiscount(Number(o.discount ?? 0)); setNote(o.note ?? '') }, [])
  useEffect(() => { let live = true; commerce.order(id).then((o) => { if (live) apply(o) }).catch((e) => { if (live) setError(errorText(e)) }); return () => { live = false } }, [id, apply])
  if (!order) return <DetailSkeleton error={error} />
  const run = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); setError(''); try { await fn(); apply(await commerce.order(id)); toast.success(ok) } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }
  const invalid = lines.some((l) => !Number.isFinite(l.unit_price) || l.unit_price < 0 || !Number.isInteger(l.quantity) || l.quantity < 1) || ![vat, shipping, discount].every(Number.isFinite)
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 pb-20 print:block print:pb-0">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 print:hidden">
        <PageHeader title={`Đơn ${order.order_number}`} description={`${dateText(order.created_at)} · ${order.customer_address ?? 'Chưa có địa chỉ'}`} actions={<Button type="button" variant="outline" onClick={() => go('/orders')}><ArrowLeft />Danh sách</Button>} />
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="grid content-start gap-4">
            <Card><CardHeader><CardTitle className="text-base">Khách hàng</CardTitle></CardHeader><CardContent className="grid gap-4">
              <p className="text-sm"><strong>{order.customer_name}</strong> · {order.customer_phone}{order.customer_email ? ` · ${order.customer_email}` : ''}</p>
              <div className="grid gap-4 sm:grid-cols-3">
                <Label className="grid content-start gap-2">Trạng thái<NativeSelect disabled={busy || !can(user, 'orders:update_status')} value={order.status} onChange={(e) => run(() => commerce.orderStatus(id, e.target.value), 'Đã cập nhật trạng thái.')}>{Object.entries(ORDER_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></Label>
                <Label className="grid content-start gap-2">Thanh toán<NativeSelect disabled={busy || !canEdit} value={order.payment_status} onChange={(e) => run(() => commerce.orderPayment(id, e.target.value), 'Đã cập nhật thanh toán.')}>{Object.entries(PAYMENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></Label>
                {can(user, 'orders:assign') && <Label className="grid content-start gap-2">Phụ trách<Assign value={order.assigned_to} users={assignees} disabled={busy} onChange={(uid) => run(() => commerce.orderAssign(id, uid), 'Đã cập nhật người phụ trách.')} /></Label>}
              </div>
            </CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base">Sản phẩm</CardTitle></CardHeader><CardContent className="grid gap-4">
              <LinesTable lines={lines} setLines={setLines} disabled={!canEdit || busy} />
              <div className="grid gap-4 sm:grid-cols-3"><NumberField label="VAT (%)" value={vat} onChange={setVat} disabled={!canEdit || busy} max={100} step={1} /><NumberField label="Phí vận chuyển" value={shipping} onChange={setShipping} disabled={!canEdit || busy} /><NumberField label="Giảm giá" value={discount} onChange={setDiscount} disabled={!canEdit || busy} /></div>
              <div className="grid gap-2"><Label htmlFor="order-note">Ghi chú</Label><Textarea id="order-note" rows={3} disabled={!canEdit || busy} value={note} onChange={(e) => setNote(e.target.value)} /></div>
              <Totals subtotal={lines.reduce((sum, l) => sum + lineTotal(l), 0)} vat={vat} shipping={shipping} discount={discount} />
            </CardContent></Card>
          </div>
          <div className="legacy overflow-x-auto [zoom:.42] md:[zoom:.9] xl:[zoom:.6]"><Print title="Đơn hàng" customer={{ name: order.customer_name, phone: order.customer_phone, email: order.customer_email, code: order.order_number }} lines={lines} vat={vat} shipping={shipping} discount={discount} notes={note} /></div>
        </div>
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
          {canEdit && <Button className={CTA} disabled={busy || invalid} onClick={() => run(() => commerce.orderSave(id, { items: lines.map((l) => ({ id: l.id, unit_price: l.unit_price, quantity: l.quantity })), vat_rate: vat, shipping_fee: shipping, discount, note }), 'Đã lưu đơn hàng.')}>{busy ? <Loader2 className="animate-spin" /> : <Save />}Lưu</Button>}
          <Button type="button" variant="outline" onClick={() => window.print()}><Printer />In đơn</Button>
        </div>
      </div>
      <div className="legacy hidden print:block"><Print title="Đơn hàng" customer={{ name: order.customer_name, phone: order.customer_phone, email: order.customer_email, code: order.order_number }} lines={lines} vat={vat} shipping={shipping} discount={discount} notes={note} /></div>
    </div>
  )
}

export function QuotesList({ user, go }: { user: User; go: Go }) {
  const [status, setStatus] = useState(''); const [q, setQ] = useState(''); const [term, setTerm] = useState(''); const [page, setPage] = useState(1)
  const [data, setData] = useState<{ items: QuoteRow[]; total: number; counts: Record<string, number> } | null>(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0)
  const assignees = useAssignees(can(user, 'quotes:update'))
  useEffect(() => { const t = setTimeout(() => { setTerm(q.trim()); setPage(1) }, 300); return () => clearTimeout(t) }, [q])
  useEffect(() => { let live = true; commerce.quotes({ q: term, status, page, limit: 20 }).then((d) => { if (live) { setData(d); setError('') } }).catch((e) => { if (live) setError(errorText(e)) }); return () => { live = false } }, [term, status, page, reload])
  const act = async (run: () => Promise<unknown>) => { try { await run(); setReload((n) => n + 1); toast.success('Đã cập nhật.') } catch (e) { setError(errorText(e)) } }
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 20))
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <PageHeader title="Yêu cầu báo giá" description={data ? `${data.total} yêu cầu` : undefined} />
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-center gap-3 border-b p-3">
          <div className="max-w-full overflow-x-auto"><Tabs value={status} onValueChange={(v) => { setStatus(v); setPage(1) }}><TabsList>{[['', 'Tất cả'], ...Object.entries(QUOTE_STATUS)].map(([k, v]) => <TabsTrigger key={k || 'all'} value={k}>{v}{k && data ? ` (${data.counts[k] ?? 0})` : ''}</TabsTrigger>)}</TabsList></Tabs></div>
          <SearchBox label="Tìm báo giá" placeholder="Tên, số điện thoại, mã báo giá" value={q} onChange={setQ} />
        </div>
        {error && <div className="p-3"><Alert>{error}</Alert></div>}
        <Table className="min-w-[820px]">
          <TableHeader className="bg-muted/40"><TableRow className="hover:bg-transparent"><TableHead>Mã</TableHead><TableHead>Khách hàng</TableHead><TableHead>Sản phẩm</TableHead><TableHead>Trạng thái</TableHead><TableHead>Phụ trách</TableHead><TableHead>Ngày</TableHead></TableRow></TableHeader>
          <TableBody>
            {!data && <SkeletonRows rows={6} cols={6} />}
            {data?.items.map((r) => (
              <TableRow key={r.id}>
                <TableCell><Link to={`/quotes/${r.id}`} go={go}>{r.quote_number ?? `#${r.id}`}</Link></TableCell>
                <TableCell>{r.name}<p className="text-xs text-muted-foreground">{r.phone}</p></TableCell>
                <TableCell className="max-w-64 truncate">{r.item_names || '—'}</TableCell>
                <TableCell><NativeSelect aria-label={`Trạng thái ${r.quote_number ?? r.id}`} className="min-w-40" disabled={!can(user, 'quotes:update')} value={r.status} onChange={(e) => act(() => commerce.quoteStatus(r.id, e.target.value))}>{Object.entries(QUOTE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect></TableCell>
                <TableCell>{can(user, 'quotes:update') ? <Assign value={r.assigned_to} users={assignees} onChange={(id) => act(() => commerce.quoteAssign(r.id, id))} /> : r.assigned_name ?? '—'}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{dateText(r.created_at)}</TableCell>
              </TableRow>))}
          </TableBody>
        </Table>
        {data && !data.items.length && <EmptyState title="Không có yêu cầu báo giá" hint={term || status ? 'Thử đổi từ khóa hoặc bộ lọc.' : undefined} />}
        <Pager page={page} pages={pages} setPage={setPage} total={data?.total ?? 0} />
      </Card>
    </div>
  )
}

export function QuoteBuilderPage({ id, user, go }: { id: number; user: User; go: Go }) {
  const confirm = useConfirm()
  const [quote, setQuote] = useState<QuoteDetail | null>(null); const [lines, setLines] = useState<LineDraft[]>([]); const [vat, setVat] = useState(10); const [shipping, setShipping] = useState(0); const [notes, setNotes] = useState('')
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const canEdit = can(user, 'quotes:update')
  const apply = useCallback((d: QuoteDetail) => {
    setQuote(d)
    setLines(d.items.map((i) => {
      const legacy = !i.snapshot_at; const snapshot = i.sale_price_snapshot ?? i.list_price_snapshot; const base = legacy ? (snapshot ?? i.product_price ?? 0) : (snapshot ?? 0)
      return { id: i.id, name: i.product_name_snapshot || (legacy ? i.product_name : null) || 'Sản phẩm không còn trong danh mục', sku: i.product_sku_snapshot || (legacy ? i.product_sku : null) || '', unit_price: Number(i.admin_unit_price ?? base), quantity: i.admin_quantity || i.quantity }
    }))
    setVat(d.vat_rate ?? 10); setShipping(Number(d.shipping_fee ?? 0)); setNotes(d.admin_notes ?? '')
  }, [])
  useEffect(() => { let live = true; commerce.quote(id).then((d) => { if (live) apply(d) }).catch((e) => { if (live) setError(errorText(e)) }); return () => { live = false } }, [id, apply])
  if (!quote) return <DetailSkeleton error={error} />
  const body = { vat_rate: vat, shipping_fee: shipping, admin_notes: notes, items: lines.map((l) => ({ id: l.id, admin_unit_price: l.unit_price, admin_quantity: l.quantity })) }
  const invalid = lines.some((l) => !Number.isFinite(l.unit_price) || l.unit_price < 0 || !Number.isInteger(l.quantity) || l.quantity < 1) || ![vat, shipping].every(Number.isFinite)
  const run = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); setError(''); try { await fn(); apply(await commerce.quote(id)); toast.success(ok) } catch (e) { setError(e instanceof ApiError ? errorText(e) : 'Có lỗi xảy ra.') } finally { setBusy(false) } }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 pb-20 print:block print:pb-0">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 print:hidden">
        <PageHeader title={`Báo giá ${quote.quote_number ?? `#${quote.id}`}`} description={<>Trạng thái: <Badge variant={statusTone(quote.status)}>{QUOTE_STATUS[quote.status] ?? quote.status}</Badge></>} actions={<Button type="button" variant="outline" onClick={() => go('/quotes')}><ArrowLeft />Danh sách</Button>} />
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="grid content-start gap-4">
            <Card><CardHeader><CardTitle className="text-base">Khách hàng</CardTitle></CardHeader><CardContent className="grid gap-2 text-sm"><p><strong>{quote.name}</strong> · {quote.phone}{quote.email ? ` · ${quote.email}` : ''}</p>{quote.message && <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-muted-foreground">{quote.message}</p>}</CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base">Báo giá</CardTitle></CardHeader><CardContent className="grid gap-4">
              <LinesTable lines={lines} setLines={setLines} disabled={!canEdit || busy} />
              <div className="grid gap-4 sm:grid-cols-2"><NumberField label="VAT (%)" value={vat} onChange={setVat} disabled={!canEdit || busy} max={100} step={1} /><NumberField label="Phí vận chuyển" value={shipping} onChange={setShipping} disabled={!canEdit || busy} /></div>
              <div className="grid gap-2"><Label htmlFor="quote-notes">Ghi chú báo giá</Label><Textarea id="quote-notes" rows={3} disabled={!canEdit || busy} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
              <Totals subtotal={lines.reduce((sum, l) => sum + lineTotal(l), 0)} vat={vat} shipping={shipping} />
            </CardContent></Card>
          </div>
          <div className="legacy overflow-x-auto [zoom:.42] md:[zoom:.9] xl:[zoom:.6]"><Print title="Bảng báo giá" customer={{ name: quote.name, phone: quote.phone, email: quote.email, code: quote.quote_number ?? String(quote.id) }} lines={lines} vat={vat} shipping={shipping} notes={notes} /></div>
        </div>
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
          {canEdit && <Button variant="outline" disabled={busy || invalid} onClick={() => run(() => commerce.quoteSave(id, body), 'Đã lưu bản nháp báo giá.')}><Save />Lưu nháp</Button>}
          {canEdit && <Button className={CTA} disabled={busy || invalid} onClick={async () => { if (await confirm({ title: 'Hoàn thành báo giá?', description: 'Báo giá sẽ được đánh dấu Hoàn thành và thông tin khách hàng được đồng bộ vào CSKH.', confirmLabel: 'Hoàn thành' })) void run(() => commerce.quoteComplete(id, body), 'Đã hoàn thành báo giá và đồng bộ CSKH.') }}>{busy && <Loader2 className="animate-spin" />}Hoàn thành</Button>}
          <Button type="button" variant="outline" onClick={() => window.print()}><Printer />In báo giá</Button>
        </div>
      </div>
      <div className="legacy hidden print:block"><Print title="Bảng báo giá" customer={{ name: quote.name, phone: quote.phone, email: quote.email, code: quote.quote_number ?? String(quote.id) }} lines={lines} vat={vat} shipping={shipping} notes={notes} /></div>
    </div>
  )
}
