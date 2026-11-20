import { useCallback, useEffect, useState } from 'react'
import { api, can, type ResourceMeta, type User } from './api'
import { ResourceForm, ResourceList } from './Resource'
import { DashboardPage } from './Dashboard'
import { OrderDetailPage, OrdersList, QuoteBuilderPage, QuotesList } from './Commerce'
import { AppShell, type Crumb } from './Shell'
import { ConfirmProvider, Toaster } from './ui'
import { Login } from './Login'

const BASE = '/admin-next'
// Owner decision (#310): hidden from navigation and routing until the M5 review (the gateway also refuses their API routes).
const HIDDEN_RESOURCES = new Set(['partners', 'projects'])
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
  useEffect(() => { if (user) api.schema().then((all) => setResources(all.filter((r) => !HIDDEN_RESOURCES.has(r.key)))).catch(() => setResources([])) }, [user])
  useEffect(() => { if (user === null && path !== '/login') go('/login');
    const legacyProduct = path.match(/^\/products(?:\/(\d+))?$/); if (user && legacyProduct) go(legacyProduct[1] ? `/r/products/${legacyProduct[1]}` : '/r/products'); if (user && (path === '/' || path === '/login')) go(can(user, 'dashboard:read') ? '/dashboard' : '/r/products') }, [user, path, go])
  if (user === undefined) return <div className="grid min-h-svh place-items-center text-sm text-muted-foreground">Đang tải…</div>
  if (!user) return <><Login onDone={setUser} /><Toaster /></>
  const resource = path.match(/^\/r\/([a-z][a-z0-9-]*)(?:\/(new|\d+))?$/)
  const meta = resource ? resources.find((r) => r.key === resource[1]) : undefined
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
  const crumbs: Crumb[] = [{ label: 'Quản trị' }]
  if (path === '/dashboard') crumbs.push({ label: 'Tổng quan' })
  else if (order) { crumbs.push({ label: 'Đơn hàng', to: '/orders' }); if (order[1]) crumbs.push({ label: `#${order[1]}` }) }
  else if (quoteRoute) { crumbs.push({ label: 'Yêu cầu báo giá', to: '/quotes' }); if (quoteRoute[1]) crumbs.push({ label: `#${quoteRoute[1]}` }) }
  else if (meta) { crumbs.push({ label: meta.group }, { label: meta.label, to: `/r/${meta.key}` }); if (resource?.[2]) crumbs.push({ label: resource[2] === 'new' ? 'Thêm mới' : `Chỉnh sửa #${resource[2]}` }) }
  return (
    <ConfirmProvider>
      <AppShell user={user} resources={resources} path={path} go={go} crumbs={crumbs} onLogout={async () => { await api.logout().catch(() => undefined); setUser(null); setResources([]); go('/login') }}>{content}</AppShell>
      <Toaster />
    </ConfirmProvider>
  )
}
