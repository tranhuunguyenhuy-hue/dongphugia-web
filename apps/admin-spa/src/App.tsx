import { useCallback, useEffect, useState } from 'react'
import { api, can, errorText, type ResourceMeta, type User } from './api'
import { ResourceForm, ResourceList } from './Resource'
import { DashboardPage, OrderDetailPage, OrdersList, QuoteBuilderPage, QuotesList } from './Commerce'

const BASE = '/admin-next'
// Same order as the legacy sidebar (Sản phẩm links first, then business, content, partners, system).
const GROUP_ORDER = ['Sản phẩm', 'Kinh doanh', 'Nội dung', 'Đối tác & Dự án', 'Hệ thống']
function useRoute() {
  const [path, setPath] = useState(() => window.location.pathname.slice(BASE.length) || '/')
  useEffect(() => { const on = () => setPath(window.location.pathname.slice(BASE.length) || '/'); window.addEventListener('popstate', on); return () => window.removeEventListener('popstate', on) }, [])
  const go = useCallback((to: string) => { window.history.pushState({}, '', BASE + to); setPath(to) }, [])
  return { path, go }
}

export function App() {
  const { path, go } = useRoute()
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [resources, setResources] = useState<ResourceMeta[]>([])
  useEffect(() => { api.me().then(setUser).catch(() => setUser(null)) }, [])
  useEffect(() => { if (user) api.schema().then(setResources).catch(() => setResources([])) }, [user])
  useEffect(() => { if (user === null && path !== '/login') go('/login');
    const legacyProduct = path.match(/^\/products(?:\/(\d+))?$/); if (user && legacyProduct) go(legacyProduct[1] ? `/r/products/${legacyProduct[1]}` : '/r/products'); if (user && (path === '/' || path === '/login')) go(can(user, 'dashboard:read') ? '/dashboard' : '/r/products') }, [user, path, go])
  if (user === undefined) return <p className="center muted">Đang tải…</p>
  if (!user) return <Login onDone={setUser} />
  const resource = path.match(/^\/r\/([a-z][a-z0-9-]*)(?:\/(new|\d+))?$/)
  const meta = resource ? resources.find((r) => r.key === resource[1]) : undefined
  const present = new Set(resources.filter((r) => r.inNav).map((r) => r.group))
  const groups = [...GROUP_ORDER.filter((g) => present.has(g)), ...[...present].filter((g) => !GROUP_ORDER.includes(g))]
  const link = (to: string, label: string) => <a key={to} href={BASE + to} onClick={(e) => { e.preventDefault(); go(to) }} aria-current={path === to || path.startsWith(to + '/') ? 'page' : undefined}>{label}</a>
  const order = path.match(/^\/orders(?:\/(\d+))?$/); const quoteRoute = path.match(/^\/quotes(?:\/(\d+))?$/)
  let content
  if (path === '/dashboard') content = can(user, 'dashboard:read') ? <DashboardPage go={go} /> : <section className="card"><p className="muted">Bạn không có quyền xem tổng quan.</p></section>
  else if (order) content = order[1] ? <OrderDetailPage key={order[1]} id={Number(order[1])} user={user} go={go} /> : <OrdersList user={user} go={go} />
  else if (quoteRoute) content = quoteRoute[1] ? <QuoteBuilderPage key={quoteRoute[1]} id={Number(quoteRoute[1])} user={user} go={go} /> : <QuotesList user={user} go={go} />
  else if (resource) {
    if (!meta) content = <section className="card"><p className="muted">{resources.length ? 'Không tìm thấy hoặc không có quyền truy cập.' : 'Đang tải…'}</p></section>
    else if (resource[2] === 'new') content = <ResourceForm key={`${meta.key}:new`} meta={meta} id={null} go={go} />
    else if (resource[2]) content = <ResourceForm key={`${meta.key}:${resource[2]}`} meta={meta} id={Number(resource[2])} go={go} resources={resources} />
    else content = <ResourceList key={meta.key} meta={meta} go={go} />
  } else content = <section className="card"><p className="muted">Không tìm thấy trang.</p></section>
  return (
    <div className="shell">
      <header className="top">
        <strong>Đông Phú Gia · Quản trị</strong>
        <nav aria-label="Chức năng">
          {can(user, 'dashboard:read') && link('/dashboard', 'Tổng quan')}
          {(can(user, 'orders:read') || can(user, 'orders:read_assigned')) && link('/orders', 'Đơn hàng')}
          {(can(user, 'quotes:read') || can(user, 'quotes:read_assigned')) && link('/quotes', 'Yêu cầu báo giá')}
          {groups.map((group) => (
            <span key={group} className="group"><span className="muted">{group}:</span>{resources.filter((r) => r.group === group && r.inNav).map((r) => link(`/r/${r.key}`, r.label))}</span>
          ))}
        </nav>
        <span className="muted">{user.name} · {user.role}</span>
        <button onClick={async () => { await api.logout().catch(() => undefined); setUser(null); setResources([]); go('/login') }}>Đăng xuất</button>
      </header>
      <main>{content}</main>
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
