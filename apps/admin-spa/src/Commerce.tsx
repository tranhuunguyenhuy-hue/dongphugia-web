// Dashboard, orders and quote requests (dedicated function handlers). Totals shown here are previews: the server
// recomputes them from the stored lines on save.
import { useCallback, useEffect, useState } from 'react'
import { ApiError, can, commerce, errorText, type OrderDetail, type OrderRow, type QuoteDetail, type QuoteRow, type User } from './api'

const BASE = '/admin-next'
type Go = (to: string) => void
const money = (value: number | null | undefined) => (value === null || value === undefined ? '—' : new Intl.NumberFormat('vi-VN').format(value) + ' đ')
const dateText = (value: string) => new Date(value).toLocaleString('vi-VN')
const Link = ({ to, go, children }: { to: string; go: Go; children: React.ReactNode }) => <a href={BASE + to} onClick={(e) => { e.preventDefault(); go(to) }}>{children}</a>

export const ORDER_STATUS: Record<string, string> = { pending: 'Chờ xử lý', received: 'Đã tiếp nhận', confirmed: 'Đã xác nhận', inventory_check: 'Kiểm tra kho', completed: 'Hoàn thành', cancelled: 'Đã huỷ' }
export const PAYMENT_STATUS: Record<string, string> = { unpaid: 'Chưa thanh toán', paid: 'Đã thanh toán', refunded: 'Đã hoàn tiền' }
export const QUOTE_STATUS: Record<string, string> = { pending: 'Chờ xử lý', resolved: 'Đang làm báo giá', completed: 'Hoàn thành', cancelled: 'Đã huỷ' }

function useAssignees(enabled: boolean) {
  const [list, setList] = useState<{ id: number; name: string; role: string }[]>([])
  useEffect(() => { if (enabled) commerce.assignees().then(setList).catch(() => setList([])) }, [enabled])
  return list
}

function Assign({ value, users, onChange, disabled }: { value: number | null; users: { id: number; name: string }[]; onChange: (id: number | null) => void; disabled?: boolean }) {
  return <select aria-label="Giao cho" disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}><option value="">Chưa giao</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
}

export function OrdersList({ user, go }: { user: User; go: Go }) {
  const [q, setQ] = useState(''); const [term, setTerm] = useState(''); const [status, setStatus] = useState(''); const [payment, setPayment] = useState(''); const [page, setPage] = useState(1)
  const [data, setData] = useState<{ items: OrderRow[]; total: number; stats: { total: number; pending: number; processing: number; completed: number; revenue: number } } | null>(null)
  const [error, setError] = useState(''); const [reload, setReload] = useState(0); const assignees = useAssignees(can(user, 'orders:assign'))
  useEffect(() => { const t = setTimeout(() => { setTerm(q.trim()); setPage(1) }, 300); return () => clearTimeout(t) }, [q])
  useEffect(() => { let live = true; commerce.orders({ q: term, status, payment_status: payment, page, limit: 20 }).then((d) => { if (live) { setData(d); setError('') } }).catch((e) => { if (live) setError(errorText(e)) }); return () => { live = false } }, [term, status, payment, page, reload])
  const act = async (run: () => Promise<unknown>) => { try { await run(); setReload((n) => n + 1) } catch (e) { setError(errorText(e)) } }
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 20))
  return (
    <section className="card">
      <div className="bar"><h1>Đơn hàng ({data?.total ?? 0})</h1></div>
      {data && <p className="muted">Tổng {data.stats.total} · chờ xử lý {data.stats.pending} · đang xử lý {data.stats.processing} · hoàn thành {data.stats.completed} · doanh thu {money(data.stats.revenue)}</p>}
      <div className="bar">
        <input type="search" aria-label="Tìm đơn hàng" placeholder="Mã đơn, tên, số điện thoại" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="inline">Trạng thái<select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1) }}><option value="">Tất cả</option>{Object.entries(ORDER_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="inline">Thanh toán<select value={payment} onChange={(e) => { setPayment(e.target.value); setPage(1) }}><option value="">Tất cả</option>{Object.entries(PAYMENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="scroll"><table>
        <thead><tr><th>Mã đơn</th><th>Khách hàng</th><th>Tổng</th><th>Trạng thái</th><th>Thanh toán</th><th>Phụ trách</th><th>Ngày</th></tr></thead>
        <tbody>
          {data?.items.map((o) => (
            <tr key={o.id}>
              <td><Link to={`/orders/${o.id}`} go={go}>{o.order_number}</Link></td><td>{o.customer_name}<br /><span className="muted">{o.customer_phone}</span></td><td>{money(o.total)}</td>
              <td><select aria-label={`Trạng thái ${o.order_number}`} disabled={!can(user, 'orders:update_status')} value={o.status} onChange={(e) => act(() => commerce.orderStatus(o.id, e.target.value))}>{Object.entries(ORDER_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
              <td>{PAYMENT_STATUS[o.payment_status] ?? o.payment_status}</td>
              <td>{can(user, 'orders:assign') ? <Assign value={o.assigned_to} users={assignees} onChange={(id) => act(() => commerce.orderAssign(o.id, id))} /> : o.assigned_name ?? '—'}</td>
              <td>{dateText(o.created_at)}</td>
            </tr>))}
          {data && !data.items.length && <tr><td colSpan={7} className="muted">Không có đơn hàng.</td></tr>}
        </tbody></table></div>
      <div className="bar"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Trước</button><span>Trang {page}/{pages}</span><button disabled={page >= pages} onClick={() => setPage(page + 1)}>Sau</button></div>
    </section>
  )
}

type LineDraft = { id: number; name: string; sku: string; unit_price: number; quantity: number }
const lineTotal = (l: { unit_price: number; quantity: number }) => (Number.isFinite(l.unit_price) && Number.isFinite(l.quantity) ? l.unit_price * l.quantity : 0)

function Totals({ subtotal, vat, shipping, discount }: { subtotal: number; vat: number; shipping: number; discount?: number }) {
  const vatAmount = subtotal * vat / 100; const total = subtotal + vatAmount + shipping - (discount ?? 0)
  return <div className="totals"><p><span>Tạm tính</span><span>{money(subtotal)}</span></p><p><span>VAT ({vat}%)</span><span>{money(vatAmount)}</span></p><p><span>Phí vận chuyển</span><span>{money(shipping)}</span></p>{discount !== undefined && <p><span>Giảm giá</span><span>−{money(discount)}</span></p>}<p className="grand"><span>Tổng cộng</span><span>{money(total)}</span></p></div>
}

function Print({ title, customer, lines, vat, shipping, discount, notes }: { title: string; customer: { name: string; phone: string; email: string | null; code: string }; lines: LineDraft[]; vat: number; shipping: number; discount?: number; notes: string }) {
  const subtotal = lines.reduce((sum, l) => sum + lineTotal(l), 0); const today = new Date()
  return (
    <div className="a4">
      <div className="a4-head"><h2>ĐÔNG PHÚ GIA</h2><p><strong>CÔNG TY TNHH ĐÔNG PHÚ GIA</strong></p><p>Hotline: 0913 865 685 · Phòng KD: 0855 528 688</p><p>Địa chỉ: 273–275 Phan Đình Phùng, Phường 2, Đà Lạt, Lâm Đồng</p></div>
      <h3 className="a4-title">{title}</h3><p className="center-text"><em>Ngày {today.getDate()} tháng {today.getMonth() + 1} năm {today.getFullYear()}</em></p>
      <div className="a4-cols"><div><p><strong>Khách hàng:</strong> {customer.name}</p><p><strong>Điện thoại:</strong> {customer.phone}</p></div><div><p><strong>Email:</strong> {customer.email || '—'}</p><p><strong>Mã:</strong> {customer.code}</p></div></div>
      <table><thead><tr><th>STT</th><th>Tên sản phẩm</th><th>SL</th><th>Đơn giá</th><th>Thành tiền</th></tr></thead>
        <tbody>{lines.map((l, i) => <tr key={l.id}><td>{i + 1}</td><td>{l.name}{l.sku && <><br /><small>Mã: {l.sku}</small></>}</td><td>{l.quantity}</td><td>{money(l.unit_price)}</td><td>{money(lineTotal(l))}</td></tr>)}</tbody></table>
      <Totals subtotal={subtotal} vat={vat} shipping={shipping} discount={discount} />
      {notes && <><p><strong>Ghi chú:</strong></p><p className="pre">{notes}</p></>}
      <div className="a4-sign"><div><strong>Khách hàng</strong><br /><em>(Ký, ghi rõ họ tên)</em></div><div><strong>Đại diện kinh doanh</strong><br /><em>(Ký, ghi rõ họ tên)</em><div className="sign-space" /><span>Đông Phú Gia</span></div></div>
    </div>
  )
}

const num = (value: string) => (value === '' ? NaN : Number(value))

export function OrderDetailPage({ id, user, go }: { id: number; user: User; go: Go }) {
  const [order, setOrder] = useState<OrderDetail | null>(null); const [lines, setLines] = useState<LineDraft[]>([]); const [vat, setVat] = useState(0); const [shipping, setShipping] = useState(0); const [discount, setDiscount] = useState(0); const [note, setNote] = useState('')
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const assignees = useAssignees(can(user, 'orders:assign')); const canEdit = can(user, 'orders:edit')
  const apply = useCallback((o: OrderDetail) => { setOrder(o); setLines(o.items.map((i) => ({ id: i.id, name: i.product_name, sku: i.product_sku, unit_price: Number(i.unit_price ?? 0), quantity: i.quantity }))); setVat(o.vat_rate); setShipping(Number(o.shipping_fee ?? 0)); setDiscount(Number(o.discount ?? 0)); setNote(o.note ?? '') }, [])
  useEffect(() => { let live = true; commerce.order(id).then((o) => { if (live) apply(o) }).catch((e) => { if (live) setError(errorText(e)) }); return () => { live = false } }, [id, apply])
  if (!order) return <section className="card">{error ? <p role="alert" className="error">{error}</p> : <p className="muted">Đang tải…</p>}</section>
  const run = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); setError(''); setMessage(''); try { await fn(); apply(await commerce.order(id)); setMessage(ok) } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }
  const invalid = lines.some((l) => !Number.isFinite(l.unit_price) || l.unit_price < 0 || !Number.isInteger(l.quantity) || l.quantity < 1) || ![vat, shipping, discount].every(Number.isFinite)
  return (
    <div className="split">
      <section className="card">
        <div className="bar"><h1>Đơn {order.order_number}</h1><button type="button" onClick={() => go('/orders')}>← Danh sách</button></div>
        <p><strong>{order.customer_name}</strong> · {order.customer_phone}{order.customer_email ? ` · ${order.customer_email}` : ''}<br /><span className="muted">{order.customer_address ?? 'Chưa có địa chỉ'} · {dateText(order.created_at)}</span></p>
        <div className="grid">
          <label>Trạng thái<select disabled={busy || !can(user, 'orders:update_status')} value={order.status} onChange={(e) => run(() => commerce.orderStatus(id, e.target.value), 'Đã cập nhật trạng thái.')}>{Object.entries(ORDER_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Thanh toán<select disabled={busy || !canEdit} value={order.payment_status} onChange={(e) => run(() => commerce.orderPayment(id, e.target.value), 'Đã cập nhật thanh toán.')}>{Object.entries(PAYMENT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          {can(user, 'orders:assign') && <label>Phụ trách<Assign value={order.assigned_to} users={assignees} disabled={busy} onChange={(uid) => run(() => commerce.orderAssign(id, uid), 'Đã cập nhật người phụ trách.')} /></label>}
        </div>
        <div className="scroll"><table><thead><tr><th>Sản phẩm</th><th>Đơn giá</th><th>SL</th><th>Thành tiền</th></tr></thead><tbody>
          {lines.map((l, i) => <tr key={l.id}><td>{l.name}<br /><span className="muted">{l.sku}</span></td>
            <td><input aria-label={`Đơn giá ${l.name}`} type="number" min={0} disabled={!canEdit || busy} value={Number.isNaN(l.unit_price) ? '' : l.unit_price} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unit_price: num(e.target.value) } : x)))} /></td>
            <td><input aria-label={`Số lượng ${l.name}`} type="number" min={1} step={1} disabled={!canEdit || busy} value={Number.isNaN(l.quantity) ? '' : l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: num(e.target.value) } : x)))} /></td>
            <td>{money(lineTotal(l))}</td></tr>)}</tbody></table></div>
        <div className="grid">
          <label>VAT (%)<input type="number" min={0} max={100} step={1} disabled={!canEdit || busy} value={Number.isNaN(vat) ? '' : vat} onChange={(e) => setVat(num(e.target.value))} /></label>
          <label>Phí vận chuyển<input type="number" min={0} disabled={!canEdit || busy} value={Number.isNaN(shipping) ? '' : shipping} onChange={(e) => setShipping(num(e.target.value))} /></label>
          <label>Giảm giá<input type="number" min={0} disabled={!canEdit || busy} value={Number.isNaN(discount) ? '' : discount} onChange={(e) => setDiscount(num(e.target.value))} /></label>
        </div>
        <label>Ghi chú<textarea rows={3} disabled={!canEdit || busy} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <Totals subtotal={lines.reduce((sum, l) => sum + lineTotal(l), 0)} vat={vat} shipping={shipping} discount={discount} />
        {error && <p role="alert" className="error">{error}</p>}{message && <p role="status" className="ok">{message}</p>}
        <div className="bar">
          {canEdit && <button disabled={busy || invalid} onClick={() => run(() => commerce.orderSave(id, { items: lines.map((l) => ({ id: l.id, unit_price: l.unit_price, quantity: l.quantity })), vat_rate: vat, shipping_fee: shipping, discount, note }), 'Đã lưu đơn hàng.')}>Lưu</button>}
          <button type="button" onClick={() => window.print()}>In đơn</button>
        </div>
      </section>
      <section className="print-pane"><Print title="Đơn hàng" customer={{ name: order.customer_name, phone: order.customer_phone, email: order.customer_email, code: order.order_number }} lines={lines} vat={vat} shipping={shipping} discount={discount} notes={note} /></section>
    </div>
  )
}

export function QuotesList({ user, go }: { user: User; go: Go }) {
  const [status, setStatus] = useState(''); const [q, setQ] = useState(''); const [term, setTerm] = useState(''); const [page, setPage] = useState(1)
  const [data, setData] = useState<{ items: QuoteRow[]; total: number; counts: Record<string, number> } | null>(null); const [error, setError] = useState(''); const [reload, setReload] = useState(0)
  const assignees = useAssignees(can(user, 'quotes:update'))
  useEffect(() => { const t = setTimeout(() => { setTerm(q.trim()); setPage(1) }, 300); return () => clearTimeout(t) }, [q])
  useEffect(() => { let live = true; commerce.quotes({ q: term, status, page, limit: 20 }).then((d) => { if (live) { setData(d); setError('') } }).catch((e) => { if (live) setError(errorText(e)) }); return () => { live = false } }, [term, status, page, reload])
  const act = async (run: () => Promise<unknown>) => { try { await run(); setReload((n) => n + 1) } catch (e) { setError(errorText(e)) } }
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 20))
  return (
    <section className="card">
      <div className="bar"><h1>Yêu cầu báo giá ({data?.total ?? 0})</h1></div>
      <div className="tabs" role="tablist">{[['', 'Tất cả'], ...Object.entries(QUOTE_STATUS)].map(([k, v]) => <button key={k} role="tab" aria-selected={status === k} className={status === k ? 'tab on' : 'tab'} onClick={() => { setStatus(k); setPage(1) }}>{v}{k && data ? ` (${data.counts[k] ?? 0})` : ''}</button>)}</div>
      <input type="search" aria-label="Tìm báo giá" placeholder="Tên, số điện thoại, mã báo giá" value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <p role="alert" className="error">{error}</p>}
      <div className="scroll"><table><thead><tr><th>Mã</th><th>Khách hàng</th><th>Sản phẩm</th><th>Trạng thái</th><th>Phụ trách</th><th>Ngày</th></tr></thead><tbody>
        {data?.items.map((r) => (
          <tr key={r.id}>
            <td><Link to={`/quotes/${r.id}`} go={go}>{r.quote_number ?? `#${r.id}`}</Link></td><td>{r.name}<br /><span className="muted">{r.phone}</span></td><td>{r.item_names || '—'}</td>
            <td><select aria-label={`Trạng thái ${r.quote_number ?? r.id}`} disabled={!can(user, 'quotes:update')} value={r.status} onChange={(e) => act(() => commerce.quoteStatus(r.id, e.target.value))}>{Object.entries(QUOTE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
            <td>{can(user, 'quotes:update') ? <Assign value={r.assigned_to} users={assignees} onChange={(id) => act(() => commerce.quoteAssign(r.id, id))} /> : r.assigned_name ?? '—'}</td><td>{dateText(r.created_at)}</td>
          </tr>))}
        {data && !data.items.length && <tr><td colSpan={6} className="muted">Không có yêu cầu báo giá.</td></tr>}
      </tbody></table></div>
      <div className="bar"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Trước</button><span>Trang {page}/{pages}</span><button disabled={page >= pages} onClick={() => setPage(page + 1)}>Sau</button></div>
    </section>
  )
}

export function QuoteBuilderPage({ id, user, go }: { id: number; user: User; go: Go }) {
  const [quote, setQuote] = useState<QuoteDetail | null>(null); const [lines, setLines] = useState<LineDraft[]>([]); const [vat, setVat] = useState(10); const [shipping, setShipping] = useState(0); const [notes, setNotes] = useState('')
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const canEdit = can(user, 'quotes:update')
  const apply = useCallback((d: QuoteDetail) => {
    setQuote(d)
    setLines(d.items.map((i) => {
      const legacy = !i.snapshot_at; const snapshot = i.sale_price_snapshot ?? i.list_price_snapshot; const base = legacy ? (snapshot ?? i.product_price ?? 0) : (snapshot ?? 0)
      return { id: i.id, name: i.product_name_snapshot || (legacy ? i.product_name : null) || 'Sản phẩm không còn trong danh mục', sku: i.product_sku_snapshot || (legacy ? i.product_sku : null) || '', unit_price: Number(i.admin_unit_price ?? base), quantity: i.admin_quantity || i.quantity }
    }))
    setVat(d.vat_rate ?? 10); setShipping(Number(d.shipping_fee ?? 0)); setNotes(d.admin_notes ?? '')
  }, [])
  useEffect(() => { let live = true; commerce.quote(id).then((d) => { if (live) apply(d) }).catch((e) => { if (live) setError(errorText(e)) }); return () => { live = false } }, [id, apply])
  if (!quote) return <section className="card">{error ? <p role="alert" className="error">{error}</p> : <p className="muted">Đang tải…</p>}</section>
  const body = { vat_rate: vat, shipping_fee: shipping, admin_notes: notes, items: lines.map((l) => ({ id: l.id, admin_unit_price: l.unit_price, admin_quantity: l.quantity })) }
  const invalid = lines.some((l) => !Number.isFinite(l.unit_price) || l.unit_price < 0 || !Number.isInteger(l.quantity) || l.quantity < 1) || ![vat, shipping].every(Number.isFinite)
  const run = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); setError(''); setMessage(''); try { await fn(); apply(await commerce.quote(id)); setMessage(ok) } catch (e) { setError(e instanceof ApiError ? errorText(e) : 'Có lỗi xảy ra.') } finally { setBusy(false) } }
  return (
    <div className="split">
      <section className="card">
        <div className="bar"><h1>Báo giá {quote.quote_number ?? `#${quote.id}`}</h1><button type="button" onClick={() => go('/quotes')}>← Danh sách</button></div>
        <p><strong>{quote.name}</strong> · {quote.phone}{quote.email ? ` · ${quote.email}` : ''}<br /><span className="muted">Trạng thái: {QUOTE_STATUS[quote.status] ?? quote.status}</span></p>
        {quote.message && <p className="pre">{quote.message}</p>}
        <div className="scroll"><table><thead><tr><th>Sản phẩm</th><th>Đơn giá</th><th>SL</th><th>Thành tiền</th></tr></thead><tbody>
          {lines.map((l, i) => <tr key={l.id}><td>{l.name}<br /><span className="muted">{l.sku}</span></td>
            <td><input aria-label={`Đơn giá ${l.name}`} type="number" min={0} disabled={!canEdit || busy} value={Number.isNaN(l.unit_price) ? '' : l.unit_price} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, unit_price: num(e.target.value) } : x)))} /></td>
            <td><input aria-label={`Số lượng ${l.name}`} type="number" min={1} step={1} disabled={!canEdit || busy} value={Number.isNaN(l.quantity) ? '' : l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: num(e.target.value) } : x)))} /></td>
            <td>{money(lineTotal(l))}</td></tr>)}</tbody></table></div>
        <div className="grid"><label>VAT (%)<input type="number" min={0} max={100} step={1} disabled={!canEdit || busy} value={Number.isNaN(vat) ? '' : vat} onChange={(e) => setVat(num(e.target.value))} /></label>
          <label>Phí vận chuyển<input type="number" min={0} disabled={!canEdit || busy} value={Number.isNaN(shipping) ? '' : shipping} onChange={(e) => setShipping(num(e.target.value))} /></label></div>
        <label>Ghi chú báo giá<textarea rows={3} disabled={!canEdit || busy} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <Totals subtotal={lines.reduce((sum, l) => sum + lineTotal(l), 0)} vat={vat} shipping={shipping} />
        {error && <p role="alert" className="error">{error}</p>}{message && <p role="status" className="ok">{message}</p>}
        <div className="bar">
          {canEdit && <button disabled={busy || invalid} onClick={() => run(() => commerce.quoteSave(id, body), 'Đã lưu bản nháp báo giá.')}>Lưu nháp</button>}
          {canEdit && <button disabled={busy || invalid} onClick={() => { if (window.confirm('Báo giá này sẽ được đánh dấu Hoàn thành và thông tin khách hàng sẽ được đồng bộ vào CSKH. Tiếp tục?')) void run(() => commerce.quoteComplete(id, body), 'Đã hoàn thành báo giá và đồng bộ CSKH.') }}>Hoàn thành</button>}
          <button type="button" onClick={() => window.print()}>In báo giá</button>
        </div>
      </section>
      <section className="print-pane"><Print title="Bảng báo giá" customer={{ name: quote.name, phone: quote.phone, email: quote.email, code: quote.quote_number ?? String(quote.id) }} lines={lines} vat={vat} shipping={shipping} notes={notes} /></section>
    </div>
  )
}
