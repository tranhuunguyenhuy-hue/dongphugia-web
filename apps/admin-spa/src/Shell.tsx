import type { ReactNode } from 'react'
import { BookOpen, Boxes, ChevronRight, ChevronsUpDown, FileText, Handshake, Image, LayoutDashboard, LogOut, Package, Receipt, Settings, ShoppingCart, Tag, Users, type LucideIcon } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger } from '@/components/ui/sidebar'
import { can, type ResourceMeta, type User } from './api'

const BASE = '/admin-next'
// Same order as the legacy sidebar (products first, then business, content, partners, system).
const GROUP_ORDER = ['Sản phẩm', 'Kinh doanh', 'Nội dung', 'Đối tác & Dự án', 'Hệ thống']
const GROUP_ICON: Record<string, LucideIcon> = { 'Sản phẩm': Package, 'Kinh doanh': ShoppingCart, 'Nội dung': FileText, 'Đối tác & Dự án': Handshake, 'Hệ thống': Settings }
const KEY_ICON: Record<string, LucideIcon> = { products: Package, categories: Boxes, brands: Tag, 'blog-posts': BookOpen, banners: Image, customers: Users, users: Users }
const ROLE_LABEL: Record<string, string> = { admin: 'Quản trị viên', sale_manager: 'Quản lý bán hàng', sale: 'Nhân viên bán hàng' }
type Go = (to: string) => void
type NavItem = { to: string; label: string; icon: LucideIcon }

export function buildNav(user: User, resources: ResourceMeta[]) {
  const business: NavItem[] = []
  if (can(user, 'dashboard:read')) business.push({ to: '/dashboard', label: 'Tổng quan', icon: LayoutDashboard })
  if (can(user, 'orders:read') || can(user, 'orders:read_assigned')) business.push({ to: '/orders', label: 'Đơn hàng', icon: ShoppingCart })
  if (can(user, 'quotes:read') || can(user, 'quotes:read_assigned')) business.push({ to: '/quotes', label: 'Yêu cầu báo giá', icon: Receipt })
  const present = new Set(resources.filter((r) => r.inNav).map((r) => r.group))
  const toItem = (r: ResourceMeta, group: string): NavItem => ({ to: `/r/${r.key}`, label: r.label, icon: KEY_ICON[r.key] ?? GROUP_ICON[group] ?? Package })
  // Business resources (customers) join the dashboard/orders/quotes group instead of a second "Kinh doanh" heading.
  for (const r of resources) if (r.inNav && r.group === 'Kinh doanh') business.push(toItem(r, r.group))
  present.delete('Kinh doanh')
  const groups = [...GROUP_ORDER.filter((g) => present.has(g)), ...[...present].filter((g) => !GROUP_ORDER.includes(g))]
  return { business, groups: groups.map((group) => ({ group, items: resources.filter((r) => r.group === group && r.inNav).map((r) => toItem(r, group)) })) }
}

export type Crumb = { label: string; to?: string }
export function AppShell({ user, resources, path, go, crumbs, onLogout, children }: { user: User; resources: ResourceMeta[]; path: string; go: Go; crumbs: Crumb[]; onLogout: () => void; children: ReactNode }) {
  const { business, groups } = buildNav(user, resources)
  const active = (to: string) => path === to || path.startsWith(to + '/')
  const link = (item: NavItem) => (
    <SidebarMenuItem key={item.to}>
      <SidebarMenuButton asChild isActive={active(item.to)} tooltip={item.label}>
        <a href={BASE + item.to} aria-current={active(item.to) ? 'page' : undefined} onClick={(e) => { e.preventDefault(); go(item.to) }}><item.icon /><span>{item.label}</span></a>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
  const initials = user.name.split(/\s+/).filter(Boolean).slice(-2).map((p) => p[0]?.toUpperCase()).join('') || 'A'
  return (
    <SidebarProvider defaultOpen={typeof window === 'undefined' || window.innerWidth >= 1100}>
      <Sidebar collapsible="icon" className="print:hidden">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">ĐPG</div>
            <div className="grid min-w-0 leading-tight group-data-[collapsible=icon]:hidden"><span className="truncate text-sm font-semibold">Đông Phú Gia</span><span className="truncate text-xs text-muted-foreground">Quản trị</span></div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          {business.length > 0 && <SidebarGroup><SidebarGroupLabel>Kinh doanh</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{business.map(link)}</SidebarMenu></SidebarGroupContent></SidebarGroup>}
          {groups.map(({ group, items }) => (
            <SidebarGroup key={group}><SidebarGroupLabel>{group}</SidebarGroupLabel><SidebarGroupContent><SidebarMenu>{items.map(link)}</SidebarMenu></SidebarGroupContent></SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu><SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" aria-label="Tài khoản" className="data-[state=open]:bg-sidebar-accent">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">{initials}</div>
                  <div className="grid min-w-0 flex-1 text-left leading-tight"><span className="truncate text-sm font-medium">{user.name}</span><span className="truncate text-xs text-muted-foreground">{ROLE_LABEL[user.role] ?? user.role}</span></div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-60">
                <DropdownMenuLabel className="font-normal"><div className="grid leading-tight"><span className="truncate text-sm font-medium">{user.name}</span><span className="truncate text-xs text-muted-foreground">{user.email}</span></div></DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onLogout}><LogOut />Đăng xuất</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem></SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 print:hidden shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur">
          <SidebarTrigger aria-label="Thu gọn/mở menu" />
          <Separator orientation="vertical" className="mr-1 h-5" />
          <nav aria-label="Breadcrumb" className="min-w-0"><ol className="flex items-center gap-1 text-sm">
            {crumbs.map((crumb, i) => (
              <li key={i} className="flex min-w-0 items-center gap-1">
                {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
                {crumb.to && i < crumbs.length - 1
                  ? <a className="truncate text-muted-foreground hover:text-foreground" href={BASE + crumb.to} onClick={(e) => { e.preventDefault(); go(crumb.to!) }}>{crumb.label}</a>
                  : <span className="truncate font-medium" aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{crumb.label}</span>}
              </li>))}
          </ol></nav>
        </header>
        <main className="mx-auto w-full max-w-7xl min-w-0 flex-1 p-4 md:p-6 [&>*]:min-w-0">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}
