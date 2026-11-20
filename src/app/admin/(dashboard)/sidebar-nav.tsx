"use client"

import * as React from "react"
import Link from '@/components/admin/admin-link'
import { usePathname } from "next/navigation"
import {
  BookOpen,
  Building2,
  ClipboardList,
  FolderTree,
  Handshake,
  Images,
  LayoutDashboard,
  LayoutGrid,
  Layers3,
  LogOut,
  Package2,
  ShoppingCart,
  Tags,
  UserCog,
  Users,
} from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { logoutAction } from "@/app/admin/login/actions"
import type { SessionUser } from "@/lib/auth/session"
import { can, type Permission } from "@/lib/auth/permissions"

interface SidebarNavProps {
  currentUser: SessionUser
}

type LaunchNavItem = {
  title: string
  href: string
  icon: React.ElementType
  permissions: Permission[]
}

const LAUNCH_NAV_GROUPS: Array<{ label: string; items: LaunchNavItem[] }> = [
  {
    label: "TỔNG QUAN",
    items: [
      { title: "Dashboard", href: "/admin", icon: LayoutDashboard, permissions: ["dashboard:read"] },
    ],
  },
  {
    label: "SẢN PHẨM",
    items: [
      { title: "Tất cả sản phẩm", href: "/admin/products", icon: Package2, permissions: ["products:read"] },
      { title: "Danh mục", href: "/admin/categories", icon: FolderTree, permissions: ["categories:read"] },
      { title: "PIM", href: "/admin/pim", icon: Layers3, permissions: ["brands:read"] },
    ],
  },
  {
    label: "KINH DOANH",
    items: [
      { title: "Đơn hàng", href: "/admin/orders", icon: ShoppingCart, permissions: ["orders:read", "orders:read_assigned"] },
      { title: "Yêu cầu báo giá", href: "/admin/quote-requests", icon: ClipboardList, permissions: ["quotes:read", "quotes:read_assigned"] },
      { title: "Khách hàng", href: "/admin/customers", icon: Users, permissions: ["customers:read"] },
    ],
  },
  {
    label: "NỘI DUNG",
    items: [
      { title: "Banner trang chủ", href: "/admin/banners", icon: Images, permissions: ["blog:write"] },
      { title: "Blog Posts", href: "/admin/blog/posts", icon: BookOpen, permissions: ["blog:read"] },
      { title: "Blog Tags", href: "/admin/blog/tags", icon: Tags, permissions: ["blog:read"] },
      { title: "Banner nội dung", href: "/admin/content/banners", icon: Images, permissions: ["blog:read"] },
    ],
  },
  {
    label: "ĐỐI TÁC & DỰ ÁN",
    items: [
      { title: "Đối tác", href: "/admin/doi-tac", icon: Handshake, permissions: ["blog:write"] },
      { title: "Dự án", href: "/admin/du-an", icon: Building2, permissions: ["blog:write"] },
    ],
  },
  {
    label: "HỆ THỐNG",
    items: [
      { title: "Người dùng", href: "/admin/users", icon: UserCog, permissions: ["users:read"] },
    ],
  },
]

export default function SidebarNav({ currentUser }: SidebarNavProps) {
  const pathname = usePathname()
  const visibleNavGroups = LAUNCH_NAV_GROUPS
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.permissions.some((permission) => can(currentUser.role, permission))),
    }))
    .filter((group) => group.items.length > 0)

  return (
    <Sidebar collapsible="icon" className="border-r border-transparent bg-[#f9fafb]">
      <SidebarHeader className="py-4">
        <div className="flex items-center justify-between group-data-[collapsible=icon]:justify-center px-3">
          <Link href="/admin" className="flex items-center gap-2 group-data-[collapsible=icon]:hidden">
            <div className="bg-primary text-primary-foreground p-1.5 rounded-md shrink-0">
              <LayoutGrid className="size-4" />
            </div>
            <span className="font-bold text-[15px] tracking-tight text-primary uppercase">DPG Admin</span>
          </Link>
          <SidebarTrigger className="shrink-0 text-muted-foreground hover:bg-neutral-200/50" />
        </div>
      </SidebarHeader>
      <SidebarContent className="px-2 pb-0 gap-0">
        {visibleNavGroups.map((group) => (
          <SidebarGroup key={group.label} className="pt-4 pb-2">
            <SidebarGroupLabel className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-wider mb-2 px-2 h-auto">
              {group.label}
            </SidebarGroupLabel>
            <SidebarMenu className="gap-0.5">
              {group.items.map((item) => {
                const isActive = item.href === "/admin"
                  ? pathname === item.href
                  : pathname === item.href || pathname.startsWith(`${item.href}/`)
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={item.title}
                      className={`sidebar-item-glass h-[34px] px-2.5 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:justify-center rounded-md font-medium text-[13px] transition-colors ${isActive ? 'bg-white shadow-sm text-neutral-900' : 'text-neutral-600 hover:text-neutral-900 hover:bg-white hover:shadow-sm'}`}
                    >
                      <Link href={item.href}>
                        <item.icon className="size-4 opacity-70 shrink-0" />
                        <span className="group-data-[collapsible=icon]:hidden">{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="p-3 bg-transparent">
        <div className="flex items-center justify-between p-2.5 bg-white border border-neutral-200 rounded-[10px] shadow-[0_1px_3px_rgba(0,0,0,0.02)] group-data-[collapsible=icon]:p-1.5 group-data-[collapsible=icon]:justify-center relative">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-700 font-bold text-xs border border-neutral-200">
              {currentUser.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex flex-col overflow-hidden group-data-[collapsible=icon]:hidden">
              <span className="truncate text-[13px] font-semibold text-neutral-900 leading-tight">{currentUser.name}</span>
              <span className="truncate text-[11px] text-neutral-500 mt-0.5">{currentUser.email}</span>
            </div>
          </div>
          <form action={logoutAction} className="group-data-[collapsible=icon]:hidden">
            <button type="submit" className="text-neutral-400 hover:text-red-600 transition-colors p-1" title="Đăng xuất">
              <LogOut className="size-4" />
            </button>
          </form>
          <form action={logoutAction} className="hidden group-data-[collapsible=icon]:block absolute inset-0">
            <button type="submit" className="w-full h-full opacity-0 cursor-pointer" title="Đăng xuất"></button>
          </form>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
