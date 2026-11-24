// Commerce v1 inbox: guest ORDERS and QUOTE REQUESTS (schema dpg_commerce). Staff read the exact snapshot the customer submitted, move the status
// (Mới -> Đang xử lý -> Hoàn tất, or Huỷ), write an internal note and assign the record. Nothing here edits totals/lines/customer data and nothing says "paid":
// payment, delivery and cost are confirmed with the customer outside the system.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Loader2, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { ApiError, can, commerce, errorText, type SalesDetail, type SalesKind, type SalesRow, type SalesStatus, type User } from './api'
import { Alert, CTA, EmptyState, NativeSelect, PageHeader, SkeletonRows, money, toast, useConfirm } from './ui'

const BASE = '/admin-next'
type Go = (to: string) => void
export const SALES_STATUS: Record<SalesStatus, string> = { new: 'Mới', processing: 'Đang xử lý', done: 'Hoàn tất', cancelled: 'Đã huỷ' }
const REASON: Record<string, string> = { NO_PRICE: 'Chưa có giá bán trực tuyến', QUOTE_ONLY: 'Chỉ bán theo báo giá', CUSTOMER_REQUEST: 'Khách chủ động yêu cầu' }
const KIND_LABEL: Record<SalesKind, { title: string; one: string; nav: string }> = { orders: { title: 'Đơn hàng', one: 'Đơn hàng', nav: 'orders' }, quotes: { title: 'Yêu cầu báo giá', one: 'Yêu cầu báo giá', nav: 'quotes' } }
const dateText = (value: string) => new Date(value).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })
const tone = (status: SalesStatus): 'secondary' | 'outline' | 'destructive' | 'default' => (status === 'done' ? 'secondary' : status === 'cancelled' ? 'destructive' : status === 'new' ? 'default' : 'outline')
const Link = ({ to, go, children }: { to: string; go: Go; children: ReactNode }) => <a className="font-medium hover:underline" href={BASE + to} onClick={(e) => { e.preventDefault(); go(to) }}>{children}</a>
const PAGE = 20

export function SalesList({ kind, user, go }: { kind: SalesKind; user: User; go: Go }) {
  void user
  const [q, setQ] = useState(''), [term, setTerm] = useState(''), [status, setStatus] = useState(''), [page, setPage] = useState(1)
  const [data, setData] = useState<{ items: SalesRow[]; total: number; counts: Record<SalesStatus, number> } | null>(null), [error, setError] = useState('')
  useEffect(() => { const t = setTimeout(() => { setTerm(q.trim()); setPage(1) }, 300); return () => clearTimeout(t) }, [q])
  useEffect(() => { let live = true; commerce.list(kind, { q: term, status, page, limit: PAGE }).then((d) => { if (live) { setData(d); setError('') } }).catch((e) => { if (live) setError(errorText(e)) }); return () => { live = false } }, [kind, term, status, page])
  const label = KIND_LABEL[kind], pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE))
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <PageHeader title={label.title} description="Do khách gửi từ website. Thanh toán, giao hàng và chi phí được xác nhận trực tiếp với khách." />
      {error && <Alert>{error}</Alert>}
      <Tabs value={status || 'all'} onValueChange={(v) => { setStatus(v === 'all' ? '' : v); setPage(1) }}>
        <TabsList>
          <TabsTrigger value="all">Tất cả{data ? ` (${Object.values(data.counts).reduce((a, b) => a + b, 0)})` : ''}</TabsTrigger>
          {(Object.keys(SALES_STATUS) as SalesStatus[]).map((s) => <TabsTrigger key={s} value={s}>{SALES_STATUS[s]}{data ? ` (${data.counts[s]})` : ''}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      <div className="relative min-w-52 sm:max-w-sm"><Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" /><Input type="search" aria-label="Tìm theo mã, tên hoặc số điện thoại" placeholder="Mã, tên, số điện thoại" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <Card className="py-0"><CardContent className="p-0">
        {!data ? <SkeletonRows rows={6} cols={6} /> : data.items.length === 0 ? <EmptyState title={`Chưa có ${label.title.toLowerCase()}`} hint="Khi khách gửi từ website, dữ liệu xuất hiện tại đây." /> : (
          <Table>
            <TableHeader><TableRow><TableHead>Mã</TableHead><TableHead>Khách hàng</TableHead><TableHead>Điện thoại</TableHead>{kind === 'orders' && <TableHead className="text-right">Tổng</TableHead>}<TableHead>Sản phẩm</TableHead><TableHead>Trạng thái</TableHead><TableHead>Gửi lúc</TableHead></TableRow></TableHeader>
            <TableBody>{data.items.map((r) => (
              <TableRow key={r.id}>
                <TableCell><Link go={go} to={`/${label.nav}/${r.id}`}>{r.code}</Link></TableCell><TableCell>{r.customer_name}</TableCell><TableCell>{r.customer_phone}</TableCell>
                {kind === 'orders' && <TableCell className="text-right tabular-nums">{money(r.total_vnd)}</TableCell>}
                <TableCell>{r.line_count}</TableCell><TableCell><Badge variant={tone(r.status)}>{SALES_STATUS[r.status]}</Badge></TableCell><TableCell className="text-muted-foreground">{dateText(r.created_at)}</TableCell>
              </TableRow>))}</TableBody>
          </Table>)}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-sm">
          <span className="text-muted-foreground">{data?.total ? `${(page - 1) * PAGE + 1}–${Math.min(data.total, page * PAGE)} / ${data.total}` : ' '}</span>
          <div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft />Trước</Button><span className="text-muted-foreground tabular-nums">Trang {page}/{pages}</span><Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Sau<ChevronRight /></Button></div>
        </div>
      </CardContent></Card>
    </div>
  )
}

export function SalesDetailPage({ kind, id, user, go }: { kind: SalesKind; id: number; user: User; go: Go }) {
  const [row, setRow] = useState<SalesDetail | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [note, setNote] = useState(''), [users, setUsers] = useState<{ id: number; name: string }[]>([])
  const confirm = useConfirm(), label = KIND_LABEL[kind]
  const canAssign = can(user, 'orders:assign')
  const load = useCallback(async () => { try { const d = await commerce.get(kind, id); setRow(d); setNote(d.staff_note ?? ''); setError('') } catch (e) { setError(errorText(e)) } }, [kind, id])
  useEffect(() => { void load() }, [load])
  useEffect(() => { if (canAssign) commerce.assignees().then(setUsers).catch(() => setUsers([])) }, [canAssign])
  const run = async (work: () => Promise<SalesDetail>, ok: string) => {
    setBusy(true)
    try { const d = await work(); setRow(d); setNote(d.staff_note ?? ''); setError(''); toast.success(ok) }
    catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') { await load(); setError('Bản ghi vừa được người khác cập nhật. Đã tải lại — vui lòng kiểm tra rồi thử lại.') } else setError(errorText(e))
    }
    finally { setBusy(false) }
  }
  if (!row) return <div className="grid gap-4">{error ? <Alert>{error}</Alert> : <><Skeleton className="h-9 w-64" /><Skeleton className="h-72 rounded-xl" /></>}</div>
  const next: { status: Exclude<SalesStatus, 'new'>; label: string; danger?: boolean; permission: string }[] = row.status === 'new'
    ? [{ status: 'processing', label: 'Bắt đầu xử lý', permission: kind === 'orders' ? 'orders:update_status' : 'quotes:update' }, { status: 'cancelled', label: 'Huỷ', danger: true, permission: kind === 'orders' ? 'orders:cancel' : 'quotes:update' }]
    : row.status === 'processing'
      ? [{ status: 'done', label: 'Hoàn tất', permission: kind === 'orders' ? 'orders:update_status' : 'quotes:update' }, { status: 'cancelled', label: 'Huỷ', danger: true, permission: kind === 'orders' ? 'orders:cancel' : 'quotes:update' }]
      : []
  const change = async (status: Exclude<SalesStatus, 'new'>, danger?: boolean) => {
    if (danger && !(await confirm({ title: `Huỷ ${label.one.toLowerCase()} ${row.code}?`, description: 'Trạng thái "Đã huỷ" không thể đổi lại.', confirmLabel: 'Huỷ' }))) return
    await run(() => commerce.setStatus(kind, id, status, row.version, note.trim() && note.trim() !== (row.staff_note ?? '') ? note.trim() : undefined), 'Đã cập nhật trạng thái.')
  }
  const isOrder = kind === 'orders'
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <PageHeader title={<>{label.one} {row.code} <Badge variant={tone(row.status)} className="ml-2 align-middle">{SALES_STATUS[row.status]}</Badge></>} description={`Gửi lúc ${dateText(row.created_at)} · cập nhật ${dateText(row.updated_at)}`}
        actions={<Button variant="outline" onClick={() => go(`/${label.nav}`)}>Danh sách</Button>} />
      {error && <Alert>{error}</Alert>}
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-4">
          <Card><CardHeader><CardTitle>Sản phẩm ({row.lines.length})</CardTitle></CardHeader><CardContent className="px-0">
            <Table>
              <TableHeader><TableRow><TableHead>SKU</TableHead><TableHead>Tên</TableHead><TableHead className="text-right">SL</TableHead>{isOrder ? <><TableHead className="text-right">Đơn giá</TableHead><TableHead className="text-right">Voucher</TableHead><TableHead className="text-right">Thành tiền</TableHead></> : <><TableHead>Lý do báo giá</TableHead><TableHead className="text-right">Giá tham chiếu</TableHead></>}</TableRow></TableHeader>
              <TableBody>{row.lines.map((l) => (
                <TableRow key={l.line_no}>
                  <TableCell className="font-mono text-xs">{l.sku}</TableCell><TableCell>{l.product_name}{l.brand ? <span className="text-muted-foreground"> · {l.brand}</span> : null}</TableCell><TableCell className="text-right tabular-nums">{l.quantity}</TableCell>
                  {isOrder ? <><TableCell className="text-right tabular-nums">{money(l.unit_selling_vnd)}</TableCell><TableCell className="text-right tabular-nums">{l.line_voucher_vnd ? `−${money(l.line_voucher_vnd)}` : '—'}</TableCell><TableCell className="text-right tabular-nums">{money((l.line_subtotal_vnd ?? 0) - (l.line_voucher_vnd ?? 0))}</TableCell></>
                    : <><TableCell>{REASON[l.reason ?? ''] ?? l.reason}</TableCell><TableCell className="text-right tabular-nums">{money(l.unit_selling_vnd)}</TableCell></>}
                </TableRow>))}</TableBody>
            </Table>
            {isOrder && <dl className="mt-4 grid gap-1 px-6 text-sm"><div className="flex justify-between"><dt>Tạm tính</dt><dd className="tabular-nums">{money(row.subtotal_vnd)}</dd></div><div className="flex justify-between"><dt>Voucher</dt><dd className="tabular-nums">{row.voucher_vnd ? `−${money(row.voucher_vnd)}` : '—'}</dd></div><div className="flex justify-between text-base font-semibold"><dt>Tổng cộng (chưa gồm phí vận chuyển/lắp đặt)</dt><dd className="tabular-nums">{money(row.total_vnd)}</dd></div></dl>}
            <p className="mt-3 px-6 text-xs text-muted-foreground">Giá là bản chụp tại thời điểm khách gửi. Hệ thống không ghi nhận thanh toán: xác nhận giao hàng, chi phí và thanh toán trực tiếp với khách.</p>
          </CardContent></Card>
          <Card><CardHeader><CardTitle>Lịch sử</CardTitle></CardHeader><CardContent>
            <ul className="grid gap-1 text-sm">{row.events.map((e, i) => <li key={i} className="flex justify-between gap-3"><span>{e.action === 'created' ? 'Khách gửi' : e.action === 'status' ? `${SALES_STATUS[(e.from_status ?? 'new') as SalesStatus]} → ${SALES_STATUS[(e.to_status ?? 'new') as SalesStatus]}` : e.action === 'assign' ? 'Giao việc' : 'Ghi chú'} <span className="text-muted-foreground">· {e.actor === 'guest' ? 'khách' : e.actor.replace('admin:', 'nhân viên #')}</span></span><span className="text-muted-foreground">{dateText(e.at)}</span></li>)}</ul>
          </CardContent></Card>
        </div>
        <div className="grid content-start gap-4">
          <Card><CardHeader><CardTitle>Khách hàng</CardTitle></CardHeader><CardContent className="grid gap-1 text-sm">
            <p className="font-medium">{row.customer_name}</p><p><a className="text-brand hover:underline" href={`tel:${row.customer_phone}`}>{row.customer_phone}</a></p>
            {row.customer_email && <p>{row.customer_email}</p>}{row.delivery_address && <p>{row.delivery_address}</p>}{row.note && <p className="mt-2 rounded-md bg-muted p-2 text-muted-foreground">Ghi chú của khách: {row.note}</p>}
          </CardContent></Card>
          <Card><CardHeader><CardTitle>Xử lý</CardTitle></CardHeader><CardContent className="grid gap-3">
            <label className="grid gap-1 text-sm">Ghi chú nội bộ<Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} disabled={busy} /></label>
            <Button type="button" variant="outline" disabled={busy || note.trim() === (row.staff_note ?? '')} onClick={() => void run(() => commerce.setNote(kind, id, note.trim(), row.version), 'Đã lưu ghi chú.')}>Lưu ghi chú</Button>
            {next.filter((n) => can(user, n.permission)).map((n) => <Button key={n.status} type="button" disabled={busy} variant={n.danger ? 'destructive' : 'default'} className={n.danger ? undefined : CTA} onClick={() => void change(n.status, n.danger)}>{busy ? <Loader2 className="animate-spin" /> : null}{n.label}</Button>)}
            {next.length === 0 && <p className="text-sm text-muted-foreground">Trạng thái cuối — không thể thay đổi.</p>}
            {canAssign && <label className="grid gap-1 text-sm">Giao cho<NativeSelect aria-label="Giao cho" disabled={busy} value={row.assigned_to ?? ''} onChange={(e) => void run(() => commerce.assign(kind, id, e.target.value === '' ? null : Number(e.target.value), row.version), 'Đã giao việc.')}><option value="">Chưa giao</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</NativeSelect></label>}
          </CardContent></Card>
        </div>
      </div>
    </div>
  )
}
