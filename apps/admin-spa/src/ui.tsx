// Admin-only helpers on top of the shared shadcn-style primitives (src/components/ui). Keeps one look for every screen.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { Toaster as Sonner, toast } from 'sonner'
import { AlertCircle, CheckCircle2, ChevronDown, Inbox } from 'lucide-react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export { toast }
/** Brand-coloured primary call to action: exactly one per page (create / save / sign in). */
export const CTA = 'bg-brand text-white hover:bg-brand-hover focus-visible:ring-brand/40'
export const Toaster = () => <Sonner position="top-right" richColors={false} closeButton toastOptions={{ classNames: { toast: 'border bg-popover text-popover-foreground shadow-lg', description: 'text-muted-foreground' } }} />

type Confirm = { title: string; description?: string; confirmLabel?: string; destructive?: boolean }
const ConfirmContext = createContext<(options: Confirm) => Promise<boolean>>(async () => false)
export const useConfirm = () => useContext(ConfirmContext)

/** Promise-based confirmation dialog (replaces window.confirm): `if (!(await confirm({...}))) return`. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<Confirm | null>(null)
  const resolver = useRef<(value: boolean) => void>(() => undefined)
  const confirm = useCallback((next: Confirm) => new Promise<boolean>((resolve) => { resolver.current = resolve; setOptions(next) }), [])
  const close = (value: boolean) => { resolver.current(value); setOptions(null) }
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={options !== null} onOpenChange={(open) => { if (!open) close(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{options?.title}</AlertDialogTitle>
            {options?.description && <AlertDialogDescription>{options.description}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Hủy</AlertDialogCancel>
            <AlertDialogAction className={cn(options?.destructive && buttonVariants({ variant: 'destructive' }))} onClick={() => close(true)}>{options?.confirmLabel ?? 'Xác nhận'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'success'; children: ReactNode }) {
  const Icon = tone === 'error' ? AlertCircle : CheckCircle2
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', tone === 'error' ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-success/30 bg-success/5 text-success')}>
      <Icon className="mt-0.5 size-4 shrink-0" /><span>{children}</span>
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-4 py-14 text-center">
      <Inbox className="mb-1 size-8 text-muted-foreground/60" />
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  )
}

export const SkeletonRows = ({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) => (
  <>{Array.from({ length: rows }, (_, r) => <tr key={r} className="border-b">{Array.from({ length: cols }, (_, c) => <td key={c} className="p-3"><Skeleton className={cn('h-4', c === 0 ? 'w-10' : c === 1 ? 'w-40' : 'w-20')} /></td>)}</tr>)}</>
)

/** Native select with shadcn input styling: reliable on touch devices and for assistive technology. */
export function NativeSelect({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <div className="relative">
      <select className={cn('h-9 w-full appearance-none rounded-md border border-input bg-transparent pr-8 pl-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50', className)} {...props}>{children}</select>
      <ChevronDown className="pointer-events-none absolute top-2.5 right-2.5 size-4 text-muted-foreground" />
    </div>
  )
}

export const money = (value: number | null | undefined) => (value === null || value === undefined ? '—' : new Intl.NumberFormat('vi-VN').format(value) + ' đ')
