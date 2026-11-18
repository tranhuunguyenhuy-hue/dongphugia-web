import { useCallback, useEffect, useState } from 'react'
import { api, errorText, uploadImage, type Product, type ProductRow, type User } from './api'

const BASE = '/admin-next'
function useRoute() {
  const [path, setPath] = useState(() => window.location.pathname.slice(BASE.length) || '/')
  useEffect(() => { const on = () => setPath(window.location.pathname.slice(BASE.length) || '/'); window.addEventListener('popstate', on); return () => window.removeEventListener('popstate', on) }, [])
  const go = useCallback((to: string) => { window.history.pushState({}, '', BASE + to); setPath(to) }, [])
  return { path, go }
}

export function App() {
  const { path, go } = useRoute()
  const [user, setUser] = useState<User | null | undefined>(undefined)
  useEffect(() => { api.me().then(setUser).catch(() => setUser(null)) }, [])
  useEffect(() => { if (user === null && path !== '/login') go('/login'); if (user && (path === '/' || path === '/login')) go('/products') }, [user, path, go])
  if (user === undefined) return <p className="center muted">Đang tải…</p>
  if (!user) return <Login onDone={setUser} />
  const edit = path.match(/^\/products\/(\d+)$/)
  return (
    <div className="shell">
      <header className="top">
        <strong>Đông Phú Gia · Quản trị</strong>
        <nav><a href={BASE + '/products'} onClick={(e) => { e.preventDefault(); go('/products') }}>Sản phẩm</a></nav>
        <span className="muted">{user.name} · {user.role}</span>
        <button onClick={async () => { await api.logout().catch(() => undefined); setUser(null); go('/login') }}>Đăng xuất</button>
      </header>
      <main>{edit ? <ProductEditor id={Number(edit[1])} user={user} go={go} /> : <ProductList go={go} />}</main>
    </div>
  )
}

function Login({ onDone }: { onDone: (user: User) => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  return (
    <form className="card login" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError('')
      try { onDone((await api.login(email, password)).user) } catch (err) { setError(errorText(err)); setBusy(false) }
    }}>
      <h1>Đăng nhập quản trị</h1>
      <label>Email<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>Mật khẩu<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {error && <p role="alert" className="error">{error}</p>}
      <button disabled={busy}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>
    </form>
  )
}

function ProductList({ go }: { go: (to: string) => void }) {
  const [q, setQ] = useState(''); const [term, setTerm] = useState(''); const [page, setPage] = useState(1)
  const [rows, setRows] = useState<ProductRow[]>([]); const [total, setTotal] = useState(0); const [error, setError] = useState(''); const [loadedFor, setLoadedFor] = useState('')
  const requestKey = `${term}|${page}`; const loading = loadedFor !== requestKey
  useEffect(() => { const t = setTimeout(() => { setTerm(q.trim()); setPage(1) }, 300); return () => clearTimeout(t) }, [q])
  useEffect(() => {
    let live = true
    api.products(term, page).then((r) => { if (live) { setRows(r.items); setTotal(r.total); setError(''); setLoadedFor(`${term}|${page}`) } })
      .catch((err) => { if (live) { setError(errorText(err)); setLoadedFor(`${term}|${page}`) } })
    return () => { live = false }
  }, [term, page])
  const pages = Math.max(1, Math.ceil(total / 20))
  return (
    <section className="card">
      <div className="bar"><h1>Sản phẩm ({total})</h1><input type="search" placeholder="Tìm theo tên hoặc SKU" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {error && <p role="alert" className="error">{error}</p>}
      <table>
        <thead><tr><th>ID</th><th>SKU</th><th>Tên</th><th>Xuất bản</th><th>Hiển thị</th><th>v</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}><td>{p.id}</td><td>{p.sku}</td>
              <td><a href={`${BASE}/products/${p.id}`} onClick={(e) => { e.preventDefault(); go(`/products/${p.id}`) }}>{p.name}</a></td>
              <td>{p.publication_status}</td><td>{p.pdp_visibility}</td><td>{p.version}</td></tr>
          ))}
          {!rows.length && !loading && <tr><td colSpan={6} className="muted">Không có sản phẩm.</td></tr>}
        </tbody>
      </table>
      <div className="bar"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Trước</button><span>Trang {page}/{pages}</span><button disabled={page >= pages} onClick={() => setPage(page + 1)}>Sau</button></div>
    </section>
  )
}

function ProductEditor({ id, user, go }: { id: number; user: User; go: (to: string) => void }) {
  const [product, setProduct] = useState<Product | null>(null); const [form, setForm] = useState<Partial<Product>>({}); const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const canWrite = user.role === 'admin'
  useEffect(() => { api.product(id).then((p) => { setProduct(p); setForm(p) }).catch((err) => setError(errorText(err))) }, [id])
  if (!product) return <section className="card">{error ? <p role="alert" className="error">{error}</p> : <p className="muted">Đang tải…</p>}</section>
  const set = <K extends keyof Product>(key: K, value: Product[K]) => setForm((f) => ({ ...f, [key]: value }))
  const FIELDS = ['name', 'display_name', 'description', 'image_main_url', 'is_active', 'is_featured', 'publication_status', 'pdp_visibility', 'listing_visibility', 'seo_title', 'seo_description'] as const
  return (
    <form className="card" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setMessage(''); setError('')
      const input: Record<string, unknown> = {}
      for (const key of FIELDS) if (form[key] !== product[key]) input[key] = form[key] === '' ? null : form[key]
      if (input.name === null) delete input.name
      if (!Object.keys(input).length) { setMessage('Không có thay đổi.'); setBusy(false); return }
      try { const saved = await api.saveProduct(id, product.version, input); setProduct({ ...product, ...saved }); setForm({ ...product, ...saved }); setMessage('Đã lưu.') }
      catch (err) { setError(errorText(err)) } finally { setBusy(false) }
    }}>
      <div className="bar"><h1>{product.sku}</h1><button type="button" onClick={() => go('/products')}>← Danh sách</button></div>
      <p className="muted">{product.category_name}{product.subcategory_name ? ` › ${product.subcategory_name}` : ''}{product.brand_name ? ` · ${product.brand_name}` : ''} · giá hiển thị: {product.price_display ?? 'Liên hệ báo giá'} (không sửa trong bản thử nghiệm)</p>
      <label>Tên<input required maxLength={500} disabled={!canWrite} value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} /></label>
      <label>Tên hiển thị<input maxLength={500} disabled={!canWrite} value={form.display_name ?? ''} onChange={(e) => set('display_name', e.target.value)} /></label>
      <label>Mô tả<textarea rows={5} disabled={!canWrite} value={form.description ?? ''} onChange={(e) => set('description', e.target.value)} /></label>
      <div className="image">
        {form.image_main_url ? <img src={form.image_main_url} alt="" width={120} height={120} /> : <div className="ph">Chưa có ảnh</div>}
        <label>Ảnh chính<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={!canWrite || busy} onChange={async (e) => {
          const file = e.target.files?.[0]; if (!file) return; setBusy(true); setError('')
          try { set('image_main_url', await uploadImage(file)); setMessage('Đã tải ảnh lên. Nhấn Lưu để áp dụng.') } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
        }} /></label>
      </div>
      <div className="grid">
        <label>Xuất bản<select disabled={!canWrite} value={form.publication_status} onChange={(e) => set('publication_status', e.target.value)}><option value="draft">draft</option><option value="public">public</option></select></label>
        <label>Trang sản phẩm<select disabled={!canWrite} value={form.pdp_visibility} onChange={(e) => set('pdp_visibility', e.target.value)}><option value="public">public</option><option value="hidden">hidden</option></select></label>
        <label>Danh sách<select disabled={!canWrite} value={form.listing_visibility} onChange={(e) => set('listing_visibility', e.target.value)}><option value="default">default</option><option value="low_priority">low_priority</option><option value="hidden">hidden</option></select></label>
        <label className="check"><input type="checkbox" disabled={!canWrite} checked={!!form.is_active} onChange={(e) => set('is_active', e.target.checked)} />Đang bán</label>
        <label className="check"><input type="checkbox" disabled={!canWrite} checked={!!form.is_featured} onChange={(e) => set('is_featured', e.target.checked)} />Nổi bật</label>
      </div>
      <label>SEO title<input maxLength={200} disabled={!canWrite} value={form.seo_title ?? ''} onChange={(e) => set('seo_title', e.target.value)} /></label>
      <label>SEO description<textarea rows={2} maxLength={500} disabled={!canWrite} value={form.seo_description ?? ''} onChange={(e) => set('seo_description', e.target.value)} /></label>
      {error && <p role="alert" className="error">{error}</p>}{message && <p role="status" className="ok">{message}</p>}
      {canWrite ? <button disabled={busy}>{busy ? 'Đang xử lý…' : 'Lưu'}</button> : <p className="muted">Vai trò của bạn chỉ có quyền xem.</p>}
    </form>
  )
}
