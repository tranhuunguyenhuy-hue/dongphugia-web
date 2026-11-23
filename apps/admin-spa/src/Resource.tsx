// Generic CRUD screens driven by the resource metadata served by the function (/schema). The server is the single
// source of truth for fields, validation limits, permissions and options; this file only renders them with the shared
// shadcn-style primitives, so every Admin area gets the same list/form behaviour.
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, Plus, Save, Search, Star, Trash2, Upload } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  CANONICAL_PRICE_FIELDS, LEGACY_PRICE_FIELDS, PRICE_ERROR_TEXT, SANITARY_CATEGORY_SLUG, validateCanonicalPricing,
} from '@/components/admin/products/canonical-pricing'
import { api, ApiError, displayMediaUrl, errorText, uploadImage, type FieldMeta, type ResourceMeta, type Row } from './api'
import { Alert, CTA, EmptyState, NativeSelect, PageHeader, SkeletonRows, money, toast, useConfirm } from './ui'

const RichText = lazy(() => import('./RichText'))
const BASE = '/admin-next'

export const slugify = (input: string) => String(input).replace(/[đĐ]/g, 'd').normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')

const ENUM_LABEL: Record<string, string> = {
  draft: 'Nháp', public: 'Công khai', hidden: 'Ẩn', in_stock: 'Còn hàng', out_of_stock: 'Hết hàng', discontinued: 'Ngừng kinh doanh', pre_order: 'Đặt trước', contact: 'Liên hệ',
  default: 'Mặc định', low_priority: 'Ưu tiên thấp', visible: 'Hiện', sellable: 'Có thể bán', not_sellable: 'Không bán', index: 'Index', noindex: 'Noindex',
}
const enumText = (value: string) => ENUM_LABEL[value] ?? value

function Cell({ field, value, refs }: { field: FieldMeta; value: unknown; refs?: Record<string, Option[]> }) {
  if (value === null || value === undefined || value === '') return <span className="text-muted-foreground">—</span>
  switch (field.kind) {
    case 'bool': return <Badge variant={value ? 'secondary' : 'outline'} className={value ? 'text-success' : 'text-muted-foreground'}>{value ? 'Có' : 'Không'}</Badge>
    case 'datetime': return <span className="whitespace-nowrap text-muted-foreground">{new Date(String(value)).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' })}</span>
    case 'media': return <img src={displayMediaUrl(value)} alt="" width={40} height={40} className="size-10 rounded-md border object-cover" />
    case 'strings': return <>{(value as string[]).join(', ')}</>
    case 'ref': return <>{refs?.[field.ref!]?.find((o) => o.id === Number(value))?.label ?? String(value)}</>
    case 'money': return <span className="tabular-nums">{money(Number(value))}</span>
    case 'enum': return <Badge variant="outline">{enumText(String(value))}</Badge>
    default: return <>{String(value)}</>
  }
}

export function ResourceList({ meta, go }: { meta: ResourceMeta; go: (to: string) => void }) {
  const confirm = useConfirm()
  const [q, setQ] = useState(''); const [term, setTerm] = useState(''); const [page, setPage] = useState(1); const [filters, setFilters] = useState<Record<string, string>>({})
  const [data, setData] = useState<{ items: Row[]; total: number }>({ items: [], total: 0 }); const [error, setError] = useState(''); const [loadedFor, setLoadedFor] = useState('')
  const [selected, setSelected] = useState<Set<number>>(() => new Set()); const [reload, setReload] = useState(0); const [refs, setRefs] = useState<Record<string, Option[]>>({})
  const filterKey = JSON.stringify(filters); const requestKey = `${term}|${page}|${filterKey}|${reload}`; const loading = loadedFor !== requestKey
  useEffect(() => { const t = setTimeout(() => { setTerm(q.trim()); setPage(1) }, 300); return () => clearTimeout(t) }, [q])
  useEffect(() => {
    let live = true; const key = `${term}|${page}|${filterKey}|${reload}`
    api.list(meta.key, { q: term, page, limit: 20, ...(JSON.parse(filterKey) as Record<string, string>) })
      .then((r) => { if (live) { setData({ items: r.items, total: r.total }); setError(''); setLoadedFor(key) } })
      .catch((err) => { if (live) { setError(errorText(err)); setLoadedFor(key) } })
    return () => { live = false }
  }, [meta.key, term, page, filterKey, reload])
  useEffect(() => {
    let live = true
    for (const ref of new Set(meta.fields.filter((f) => f.list && f.kind === 'ref').map((f) => f.ref!))) api.options(ref).then((items) => { if (live) setRefs((o) => ({ ...o, [ref]: items })) }).catch(() => undefined)
    return () => { live = false }
  }, [meta])
  const columns = meta.fields.filter((f) => f.list); const pages = Math.max(1, Math.ceil(data.total / 20))
  const bulk = meta.key === 'products' && meta.canUpdate
  const first = data.total === 0 ? 0 : (page - 1) * 20 + 1; const last = Math.min(data.total, page * 20)
  const runBulk = async (action: string) => {
    if (!selected.size) return
    if (action === 'delete' && !(await confirm({ title: `Xóa ${selected.size} sản phẩm?`, description: 'Thao tác không thể hoàn tác.', confirmLabel: 'Xóa', destructive: true }))) return
    try {
      const result = await api.bulkProducts([...selected], action)
      toast.success(`Đã cập nhật ${result.updated} sản phẩm${result.skipped.length ? `; bỏ qua ${result.skipped.length} (${[...new Set(result.skipped.map((s) => errorText(new ApiError(400, s.reason))))].join(' ')})` : '.'}`)
      setSelected(new Set()); setReload((n) => n + 1)
    } catch (err) { setError(errorText(err)) }
  }
  const open = (id: unknown) => go(`/r/${meta.key}/${id}`)
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <PageHeader title={meta.label} description={loading && !data.total ? undefined : `${data.total} mục`} actions={meta.canCreate && <Button className={CTA} onClick={() => go(`/r/${meta.key}/new`)}><Plus />Thêm mới</Button>} />
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          {meta.searchable && <div className="relative min-w-48 flex-1 sm:max-w-xs"><Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" /><Input type="search" aria-label="Tìm kiếm" placeholder="Tìm kiếm…" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} /></div>}
          {meta.filters.map((f) => (
            <NativeSelect key={f.name} aria-label={f.label} className="w-40" value={filters[f.name] ?? ''} onChange={(e) => { setFilters({ ...filters, [f.name]: e.target.value }); setPage(1) }}>
              <option value="">{f.label}: tất cả</option>
              {f.kind === 'bool' ? <><option value="true">{f.label}: có</option><option value="false">{f.label}: không</option></> : (f.options ?? []).map((o) => <option key={o} value={o}>{enumText(o)}</option>)}
            </NativeSelect>
          ))}
        </div>
        {bulk && selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b bg-muted/50 px-3 py-2" role="toolbar" aria-label="Thao tác hàng loạt">
            <span className="mr-1 text-sm font-medium">Đã chọn {selected.size}</span>
            {[['activate', 'Bán'], ['deactivate', 'Ngừng bán'], ['feature', 'Nổi bật'], ['unfeature', 'Bỏ nổi bật']].map(([a, l]) => <Button key={a} type="button" size="sm" variant="outline" onClick={() => runBulk(a)}>{l}</Button>)}
            {meta.canDelete && <Button type="button" size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => runBulk('delete')}><Trash2 />Xóa</Button>}
          </div>
        )}
        {error && <div className="p-3"><Alert>{error}</Alert></div>}
        <Table className="min-w-[640px]">
          <TableHeader className="bg-muted/40">
            <TableRow className="hover:bg-transparent">
              {bulk && <TableHead className="w-10 pl-3"><Checkbox aria-label="Chọn tất cả" checked={data.items.length > 0 && data.items.every((r) => selected.has(Number(r.id)))} onCheckedChange={(on) => setSelected(on === true ? new Set(data.items.map((r) => Number(r.id))) : new Set())} /></TableHead>}
              <TableHead className="w-16">ID</TableHead>{columns.map((f) => <TableHead key={f.name}>{f.label}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && !data.items.length && <SkeletonRows rows={8} cols={columns.length + 1 + (bulk ? 1 : 0)} />}
            {data.items.map((row) => (
              <TableRow key={String(row.id)} className={cn('cursor-pointer', loading && 'opacity-60')} data-state={selected.has(Number(row.id)) ? 'selected' : undefined} onClick={() => open(row.id)}>
                {bulk && <TableCell className="pl-3" onClick={(e) => e.stopPropagation()}><Checkbox aria-label={`Chọn ${row.id}`} checked={selected.has(Number(row.id))} onCheckedChange={(on) => setSelected((cur) => { const next = new Set(cur); if (on === true) next.add(Number(row.id)); else next.delete(Number(row.id)); return next })} /></TableCell>}
                <TableCell className="text-muted-foreground tabular-nums"><a href={`${BASE}/r/${meta.key}/${row.id}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); open(row.id) }}>{String(row.id)}</a></TableCell>
                {columns.map((f, i) => <TableCell key={f.name} className={cn(i === 0 && 'font-medium', 'max-w-72 truncate')}>{i === 0
                  ? <a className="hover:underline" href={`${BASE}/r/${meta.key}/${row.id}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); open(row.id) }}><Cell field={f} value={row[f.name]} refs={refs} /></a>
                  : <Cell field={f} value={row[f.name]} refs={refs} />}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!data.items.length && !loading && !error && <EmptyState title="Không có dữ liệu" hint={term || filterKey !== '{}' ? 'Thử đổi từ khóa hoặc bộ lọc.' : undefined} />}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-sm">
          <span className="text-muted-foreground">{data.total ? `Hiển thị ${first}–${last} / ${data.total}` : ' '}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft />Trước</Button>
            <span className="text-muted-foreground tabular-nums">Trang {page}/{pages}</span>
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Sau<ChevronRight /></Button>
          </div>
        </div>
      </Card>
    </div>
  )
}

type Option = { id: number; label: string }
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function initialRow(meta: ResourceMeta): Row {
  const row: Row = {}
  for (const f of meta.fields) if (f.initial !== undefined) row[f.name] = f.initial
  for (const r of meta.relations) row[r.input] = []
  return row
}

/** Request body: create sends the filled editable fields; update sends only what changed. */
export function buildInput(meta: ResourceMeta, form: Row, original: Row | null): Row {
  const input: Row = {}
  for (const f of meta.fields) {
    if (f.readOnly || !f.editable) continue
    const raw = form[f.name]
    let value: unknown
    if (f.kind === 'int') value = raw === '' || raw === null || raw === undefined ? null : Number(raw)
    else if (f.kind === 'ref') value = raw === '' || raw === null || raw === undefined ? (f.nullable ? null : undefined) : Number(raw)
    else if (f.kind === 'strings') value = Array.isArray(raw) ? raw : []
    else if (f.kind === 'json') value = raw && typeof raw === 'object' ? raw : {}
    else if (f.kind === 'money') value = raw === '' || raw === null || raw === undefined ? (f.nullable ? null : undefined) : Number(raw)
    else if (f.kind === 'bool') value = Boolean(raw)
    else value = raw ?? ''
    if (original) {
      if (value === undefined) continue
      const before = f.kind === 'int' || f.kind === 'ref' ? (original[f.name] ?? null) : f.kind === 'money' ? (original[f.name] === null || original[f.name] === undefined ? null : Number(original[f.name])) : f.kind === 'strings' ? (original[f.name] ?? []) : f.kind === 'bool' ? Boolean(original[f.name]) : f.kind === 'json' ? (original[f.name] ?? {}) : (original[f.name] ?? '')
      if (!sameJson(value, before)) input[f.name] = value
    }
    else if (value !== undefined && value !== '' && value !== null) input[f.name] = value
  }
  for (const r of meta.relations) {
    const next = (Array.isArray(form[r.input]) ? form[r.input] as number[] : []).slice().sort((a, b) => a - b)
    const prev = original ? (Array.isArray(original[r.input]) ? original[r.input] as number[] : []).slice().sort((a, b) => a - b) : []
    if (!original ? next.length > 0 : !sameJson(next, prev)) input[r.input] = next
  }
  return input
}

// Product edit is organised in tabs; fields the server adds later and that are not listed here land in "Thông tin".
const canonicalPriceNames = new Set<string>(CANONICAL_PRICE_FIELDS)
const legacyPriceNames = new Set<string>(LEGACY_PRICE_FIELDS)
const PRODUCT_TABS: { id: string; label: string; fields: string[] }[] = [
  { id: 'general', label: 'Thông tin', fields: ['sku', 'name', 'display_name', 'slug', 'category_id', 'subcategory_id', 'brand_id', 'origin_id', 'color_id', 'material_id', 'product_type_id', 'product_sub_type_id', 'product_type', 'product_sub_type', 'stock_status', 'warranty_months', 'hita_product_id', 'source_url'] },
  { id: 'pricing', label: 'Giá', fields: [...LEGACY_PRICE_FIELDS, ...CANONICAL_PRICE_FIELDS] },
  { id: 'media', label: 'Hình ảnh', fields: ['image_main_url'] },
  { id: 'content', label: 'Nội dung', fields: ['description', 'features', 'specs'] },
  { id: 'visibility', label: 'Hiển thị & SEO', fields: ['is_active', 'is_featured', 'is_home_featured', 'is_promotion', 'is_combo', 'is_master', 'sort_order', 'publication_status', 'pdp_visibility', 'listing_visibility', 'search_visibility', 'sellable_status', 'seo_indexing', 'sitemap_include', 'seo_title', 'seo_description'] },
]
const WIDE: FieldMeta['kind'][] = ['textarea', 'html', 'json', 'media', 'strings']

function Section({ title, description, children }: { title?: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      {title && <CardHeader><CardTitle className="text-base">{title}</CardTitle>{description && <p className="text-sm text-muted-foreground">{description}</p>}</CardHeader>}
      <CardContent className="grid gap-5">{children}</CardContent>
    </Card>
  )
}

export function ResourceForm({ meta, id, go, resources = [] }: { meta: ResourceMeta; id: number | null; go: (to: string) => void; resources?: ResourceMeta[] }) {
  const confirm = useConfirm()
  const creating = id === null
  const [original, setOriginal] = useState<Row | null>(null); const [form, setForm] = useState<Row>(() => initialRow(meta))
  const [options, setOptions] = useState<Record<string, Option[]>>({}); const [loaded, setLoaded] = useState(creating)
  const [jsonText, setJsonText] = useState<Record<string, string>>({}); const [jsonError, setJsonError] = useState<Record<string, boolean>>({})
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [touched, setTouched] = useState<Set<string>>(() => new Set()); const [tab, setTab] = useState('general')
  const labels = Object.fromEntries([...meta.fields.map((f) => [f.name, f.label]), ...meta.relations.map((r) => [r.input, r.label])])
  const canEdit = creating ? meta.canCreate : meta.canUpdate
  useEffect(() => {
    let live = true
    if (id !== null) api.get(meta.key, id).then((row) => { if (live) { setOriginal(row); setForm(row); setLoaded(true) } }).catch((err) => { if (live) setError(errorText(err)) })
    const refs = [...new Set([...meta.fields.filter((f) => f.kind === 'ref').map((f) => f.ref!), ...meta.relations.map((r) => r.ref)])]
    for (const ref of refs) api.options(ref).then((items) => { if (live) setOptions((o) => ({ ...o, [ref]: items })) }).catch(() => undefined)
    return () => { live = false }
  }, [meta, id])
  const isProduct = meta.key === 'products'
  const category = options.categories?.find(option => option.id === Number(form.category_id))
  const hasCanonicalPrices = isProduct && CANONICAL_PRICE_FIELDS.every(name => meta.fields.some(f => f.name === name))
  // Category options expose only an ID and the master-data label.
  const usesCanonicalPrices = hasCanonicalPrices && category !== undefined && slugify(category.label) === SANITARY_CATEGORY_SLUG
  const canResolvePricing = !hasCanonicalPrices || category !== undefined
  const priceFieldAllowed = (name: string) => {
    if (canonicalPriceNames.has(name)) return usesCanonicalPrices
    if (legacyPriceNames.has(name)) return canResolvePricing && !usesCanonicalPrices
    return true
  }
  if (!loaded) return <div className="grid gap-4">{error ? <Alert>{error}</Alert> : <><Skeleton className="h-9 w-64" /><Skeleton className="h-72 rounded-xl" /></>}</div>

  const set = (name: string, value: unknown) => setForm((f) => {
    const next: Row = { ...f, [name]: value }
    if (creating) for (const field of meta.fields) if (field.slugFrom === name && !touched.has(field.name)) next[field.name] = slugify(String(value))
    return next
  })
  const control = (f: FieldMeta) => {
    const value = form[f.name]; const disabled = !canEdit || !f.editable || f.readOnly || busy || (!creating && f.createOnly === true)
    const common = { id: `f-${f.name}`, disabled }
    switch (f.kind) {
      case 'textarea': return <Textarea {...common} rows={4} maxLength={f.max} value={String(value ?? '')} onChange={(e) => set(f.name, e.target.value)} />
      case 'html': return <Suspense fallback={<Skeleton className="h-56 rounded-md" />}><RichText value={String(value ?? '')} disabled={disabled} folder={meta.key === 'products' ? 'products' : 'blog'} onChange={(html) => set(f.name, html)} /></Suspense>
      case 'int': return <Input {...common} type="number" min={f.min} max={f.max} value={value === null || value === undefined ? '' : String(value)} onChange={(e) => set(f.name, e.target.value)} />
      case 'bool': return <Checkbox id={common.id} disabled={disabled} checked={Boolean(value)} onCheckedChange={(on) => set(f.name, on === true)} />
      case 'enum': return <NativeSelect {...common} value={String(value ?? '')} onChange={(e) => set(f.name, e.target.value)}>{creating && <option value="">—</option>}{(f.options ?? []).map((o) => <option key={o} value={o}>{enumText(o)}</option>)}</NativeSelect>
      case 'ref': return <NativeSelect {...common} value={value === null || value === undefined ? '' : String(value)} onChange={(e) => set(f.name, e.target.value)}><option value="">— chọn —</option>{(options[f.ref!] ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</NativeSelect>
      case 'strings': return <Input {...common} placeholder="Ngăn cách bằng dấu phẩy" value={Array.isArray(value) ? (value as string[]).join(', ') : ''} onChange={(e) => set(f.name, e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
      case 'media': return (
        <div className="flex flex-wrap items-start gap-4">
          {value ? <img src={displayMediaUrl(value)} alt="" width={112} height={112} className="size-28 rounded-lg border object-cover" /> : <div className="grid size-28 place-items-center rounded-lg border border-dashed text-xs text-muted-foreground">Chưa có ảnh</div>}
          <div className="grid min-w-56 flex-1 gap-2">
            <Input {...common} type="url" placeholder="https://…" value={String(value ?? '')} onChange={(e) => set(f.name, e.target.value)} />
            <Input type="file" aria-label={`Tải ảnh: ${f.label}`} accept="image/jpeg,image/png,image/webp,image/gif" disabled={disabled} onChange={async (e) => {
              const file = e.target.files?.[0]; e.target.value = ''; if (!file) return
              setBusy(true); setError('')
              try { set(f.name, await uploadImage(file, f.upload?.folder ?? 'blog', f.upload?.profile ?? 'editorial')); toast.success('Đã tải ảnh lên. Nhấn Lưu để áp dụng.') } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
            }} />
          </div>
        </div>)
      case 'json': return <Textarea {...common} rows={6} spellCheck={false} className="font-mono text-xs" value={jsonText[f.name] ?? JSON.stringify(value ?? {}, null, 2)} onChange={(e) => {
        const text = e.target.value; setJsonText((j) => ({ ...j, [f.name]: text }))
        try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { set(f.name, parsed); setJsonError((j) => ({ ...j, [f.name]: false })) } else throw new Error('shape') } catch { setJsonError((j) => ({ ...j, [f.name]: true })) }
      }} aria-invalid={jsonError[f.name] || undefined} />
      case 'password': return <Input {...common} type="password" autoComplete="new-password" minLength={8} maxLength={f.max ?? 200} value={String(value ?? '')} onChange={(e) => set(f.name, e.target.value)} />
      case 'email': return <Input {...common} type="email" autoComplete="off" maxLength={f.max} value={String(value ?? '')} onChange={(e) => set(f.name, e.target.value)} />
      case 'money': {
        const wholeVnd = isProduct && canonicalPriceNames.has(f.name)
        return <Input {...common} type="number" min={f.min ?? 0} max={wholeVnd ? f.max : undefined} step={wholeVnd ? 1 : 'any'} value={String(value ?? '')} onChange={(e) => set(f.name, e.target.value)} />
      }
      case 'datetime': return <Input {...common} disabled value={value ? new Date(String(value)).toLocaleString('vi-VN') : ''} readOnly />
      default: return <Input {...common} type="text" maxLength={f.max} value={String(value ?? '')} onChange={(e) => { if (f.slugFrom) setTouched((t) => new Set(t).add(f.name)); set(f.name, e.target.value) }} />
    }
  }
  const fieldRow = (f: FieldMeta) => f.kind === 'bool'
    ? <div key={f.name} className="flex items-center gap-2.5 rounded-md border px-3 py-2.5">{control(f)}<Label htmlFor={`f-${f.name}`} className="flex-1 cursor-pointer font-normal">{f.label}</Label></div>
    : <div key={f.name} className={cn('grid content-start gap-2', WIDE.includes(f.kind) && 'sm:col-span-2')}><Label htmlFor={`f-${f.name}`}>{f.label}{f.required && <span className="text-destructive"> *</span>}</Label>{control(f)}</div>
  const fieldGrid = (fields: FieldMeta[]) => {
    const toggles = fields.filter((f) => f.kind === 'bool'); const rest = fields.filter((f) => f.kind !== 'bool')
    return <>{rest.length > 0 && <div className="grid gap-5 sm:grid-cols-2">{rest.map(fieldRow)}</div>}{toggles.length > 0 && <div className="grid gap-3 sm:grid-cols-2">{toggles.map(fieldRow)}</div>}</>
  }
  const visibleFields = meta.fields.filter((f) => !(creating && f.readOnly) && (!isProduct || priceFieldAllowed(f.name)))
  const version = original && meta.versioned ? Number(original.version) : undefined
  const relationSections = meta.relations.map((r) => (
    <Section key={r.input} title={r.label}>
      <fieldset disabled={!canEdit || busy} className="flex flex-wrap gap-x-5 gap-y-2.5">
        {(options[r.ref] ?? []).map((o) => {
          const current = Array.isArray(form[r.input]) ? form[r.input] as number[] : []
          return <label key={o.id} className="flex cursor-pointer items-center gap-2 text-sm"><Checkbox checked={current.includes(o.id)} onCheckedChange={(on) => set(r.input, on === true ? [...current, o.id] : current.filter((x) => x !== o.id))} />{o.label}</label>
        })}
        {!(options[r.ref] ?? []).length && <span className="text-sm text-muted-foreground">Chưa có mục nào.</span>}
      </fieldset>
    </Section>))
  const childSections = !creating ? (meta.children ?? []).map((c) => { const child = resources.find((r) => r.key === c.key); return child ? <ChildPanel key={c.key} child={child} column={c.column} parentId={id} /> : null }) : []
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError('')
    const badJson = meta.fields.filter((f) => jsonError[f.name]).map((f) => f.label)
    if (badJson.length) { setError(`JSON không hợp lệ: ${badJson.join(', ')}.`); return }
    if (usesCanonicalPrices) {
      const issue = validateCanonicalPricing(form)
      if (issue) { setError(PRICE_ERROR_TEXT[issue]); setTab('pricing'); return }
    }
    const body = buildInput(isProduct ? { ...meta, fields: visibleFields } : meta, form, original)
    setBusy(true)
    if (!creating && !Object.keys(body).length) { toast('Không có thay đổi để lưu.'); setBusy(false); return }
    try {
      if (creating) { const row = await api.create(meta.key, body); toast.success('Đã tạo.'); go(`/r/${meta.key}/${row.id}`) }
      else { const row = await api.update(meta.key, id, version, body); setOriginal(row); setForm(row); toast.success('Đã lưu.') }
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'PRICE_RELATION_INVALID' || err.code === 'VOUCHER_INVALID')) {
        setError(PRICE_ERROR_TEXT[err.code]); setTab('pricing')
      } else setError(errorText(err, labels))
    } finally { setBusy(false) }
  }
  const title = creating ? `Thêm: ${meta.label}` : String(original?.name ?? original?.title ?? original?.label ?? `${meta.label} #${id}`)
  return (
    <form className="grid grid-cols-[minmax(0,1fr)] gap-4 pb-20" onSubmit={submit} noValidate={false}>
      <PageHeader title={title} description={creating ? undefined : `${meta.label} #${id}${original?.updated_at ? ` · cập nhật ${new Date(String(original.updated_at)).toLocaleString('vi-VN')}` : ''}`}
        actions={<Button type="button" variant="outline" onClick={() => go(`/r/${meta.key}`)}><ArrowLeft />Danh sách</Button>} />
      {error && <Alert>{error}</Alert>}
      {isProduct ? (
        <Tabs value={tab} onValueChange={setTab} className="min-w-0 gap-4">
          <div className="max-w-full overflow-x-auto"><TabsList>
            {PRODUCT_TABS.map((t) => <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}
            {!creating && <TabsTrigger value="links">Phân loại & biến thể</TabsTrigger>}
          </TabsList></div>
          {PRODUCT_TABS.map((t) => {
            const known = new Set(PRODUCT_TABS.flatMap((x) => x.fields))
            const fields = visibleFields.filter((f) => t.fields.includes(f.name) || (t.id === 'general' && !known.has(f.name)))
            return (
              <TabsContent key={t.id} value={t.id} className="grid gap-4">
                <Section>
                  {t.id === 'pricing' && usesCanonicalPrices && <p className="text-sm text-muted-foreground">
                    Để trống cả ba ô nếu sản phẩm cần báo giá. Voucher tính theo từng sản phẩm trong giỏ hàng.
                  </p>}
                  {t.id === 'pricing' && !canResolvePricing && <p className="text-sm text-muted-foreground">
                    {form.category_id ? 'Chưa xác định được danh mục để hiển thị các trường giá.' : 'Chọn danh mục để hiển thị các trường giá.'}
                  </p>}
                  {fieldGrid(fields)}
                </Section>
                {t.id === 'media' && !creating && <Gallery productId={id} canEdit={meta.canUpdate} mainUrl={String(form.image_main_url ?? '')} onSetMain={(url) => set('image_main_url', url)} />}
                {t.id === 'media' && creating && <p className="text-sm text-muted-foreground">Thư viện ảnh khả dụng sau khi tạo sản phẩm.</p>}
              </TabsContent>)
          })}
          {!creating && <TabsContent value="links" className="grid gap-4">{relationSections}{childSections}<Variants productId={id} canEdit={meta.canUpdate} /></TabsContent>}
        </Tabs>
      ) : (
        <>
          <Section>{fieldGrid(visibleFields)}</Section>
          {relationSections}{childSections}
        </>
      )}
      {isProduct && creating && relationSections}
      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        {canEdit ? <Button className={CTA} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Save />}{busy ? 'Đang xử lý…' : creating ? 'Tạo' : 'Lưu thay đổi'}</Button> : <p className="text-sm text-muted-foreground">Vai trò của bạn chỉ có quyền xem.</p>}
        {!creating && meta.canDelete && <Button type="button" variant="outline" className="text-destructive hover:text-destructive" disabled={busy} onClick={async () => {
          if (!(await confirm({ title: 'Xóa mục này?', description: 'Thao tác không thể hoàn tác.', confirmLabel: 'Xóa', destructive: true }))) return
          setBusy(true); setError('')
          try { await api.remove(meta.key, id, version); toast.success('Đã xóa.'); go(`/r/${meta.key}`) } catch (err) { setError(errorText(err)); setBusy(false) }
        }}><Trash2 />Xóa</Button>}
      </div>
    </form>
  )
}

/** Product gallery (product_images): upload through the legacy route, order, delete, promote to main image. */
function Gallery({ productId, canEdit, mainUrl, onSetMain }: { productId: number; canEdit: boolean; mainUrl: string; onSetMain: (url: string) => void }) {
  const confirm = useConfirm()
  const [items, setItems] = useState<Row[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true
    api.list('product-images', { product_id: productId, limit: 50 }).then((r) => { if (live) setItems(r.items) }).catch((e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [productId, reload])
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); setReload((n) => n + 1) } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }
  return (
    <Section title="Thư viện ảnh" description="Ảnh chính được lưu cùng sản phẩm: chọn «Ảnh chính» rồi nhấn Lưu thay đổi.">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((img) => (
          <figure key={String(img.id)} className="grid gap-2 rounded-lg border p-2">
            <img src={displayMediaUrl(img.image_url)} alt={String(img.alt_text ?? '')} className="aspect-square w-full rounded-md object-cover" />
            <figcaption className="grid gap-1.5">
              <Input type="number" aria-label="Thứ tự" className="h-8" disabled={!canEdit || busy} defaultValue={Number(img.sort_order ?? 0)} onBlur={(e) => { const next = Number(e.target.value); if (Number.isInteger(next) && next !== Number(img.sort_order)) void run(() => api.update('product-images', Number(img.id), undefined, { sort_order: next })) }} />
              {canEdit && <div className="flex gap-1.5">
                <Button type="button" size="xs" variant={mainUrl === img.image_url ? 'secondary' : 'outline'} className="flex-1" disabled={mainUrl === img.image_url || busy} onClick={() => onSetMain(String(img.image_url))}><Star />{mainUrl === img.image_url ? 'Đang chọn' : 'Ảnh chính'}</Button>
                <Button type="button" size="icon-xs" variant="outline" aria-label="Xóa ảnh" className="text-destructive hover:text-destructive" disabled={busy} onClick={async () => { if (await confirm({ title: 'Xóa ảnh này?', confirmLabel: 'Xóa', destructive: true })) void run(() => api.remove('product-images', Number(img.id), undefined)) }}><Trash2 /></Button>
              </div>}
            </figcaption>
          </figure>))}
        {!items.length && <p className="col-span-full text-sm text-muted-foreground">Chưa có ảnh trong thư viện.</p>}
      </div>
      {canEdit && <div className="flex max-w-md items-center gap-2"><Upload className="size-4 shrink-0 text-muted-foreground" /><Input type="file" aria-label="Thêm ảnh vào thư viện" accept="image/jpeg,image/png,image/webp,image/gif" disabled={busy} onChange={(e) => {
        const file = e.target.files?.[0]; e.target.value = ''; if (!file) return
        void run(async () => { const url = await uploadImage(file, 'products', 'product'); await api.create('product-images', { product_id: productId, image_url: url, sort_order: items.length }) })
      }} /></div>}
      {error && <Alert>{error}</Alert>}
    </Section>
  )
}

/** Compact input for one field of a child record (used by ChildPanel; the main form has its own richer inputs). */
function SimpleInput({ field, value, options, disabled, onChange }: { field: FieldMeta; value: unknown; options: { id: number; label: string }[]; disabled: boolean; onChange: (value: unknown) => void }) {
  const [jsonText, setJsonText] = useState<string | null>(null)
  const id = `c-${field.name}`
  switch (field.kind) {
    case 'bool': return <Checkbox id={id} disabled={disabled} checked={Boolean(value)} onCheckedChange={(on) => onChange(on === true)} />
    case 'enum': return <NativeSelect id={id} disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>{(field.options ?? []).map((o) => <option key={o} value={o}>{enumText(o)}</option>)}</NativeSelect>
    case 'ref': return <NativeSelect id={id} disabled={disabled} value={value === null || value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}><option value="">— chọn —</option>{options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</NativeSelect>
    case 'int': case 'money': return <Input id={id} type="number" step="any" disabled={disabled} value={value === null || value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
    case 'textarea': case 'html': return <Textarea id={id} rows={3} disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
    case 'json': return <Textarea id={id} rows={3} className="font-mono text-xs" spellCheck={false} disabled={disabled} value={jsonText ?? (value === null || value === undefined ? '' : JSON.stringify(value, null, 2))} onChange={(e) => {
      const text = e.target.value; setJsonText(text)
      if (text.trim() === '') { onChange(null); return }
      try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) onChange(parsed) } catch { /* keep the previous valid value until the text parses */ }
    }} />
    default: return <Input id={id} type={field.kind === 'url' ? 'url' : 'text'} disabled={disabled} maxLength={field.max} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
  }
}

/** Child records of a parent (documents, spec values, taxon assignments, relations): list, add, edit, delete in place. */
function ChildPanel({ child, column, parentId }: { child: ResourceMeta; column: string; parentId: number | null }) {
  const confirm = useConfirm()
  const [items, setItems] = useState<Row[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [reload, setReload] = useState(0)
  const [editing, setEditing] = useState<{ id: number | null; form: Row } | null>(null); const [options, setOptions] = useState<Record<string, { id: number; label: string }[]>>({})
  useEffect(() => {
    let live = true
    api.list(child.key, { [column]: parentId ?? '', limit: 50 }).then((r) => { if (live) setItems(r.items) }).catch((e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [child.key, column, parentId, reload])
  useEffect(() => {
    let live = true
    for (const ref of new Set(child.fields.filter((f) => f.kind === 'ref').map((f) => f.ref!))) api.options(ref).then((list) => { if (live) setOptions((o) => ({ ...o, [ref]: list })) }).catch(() => undefined)
    return () => { live = false }
  }, [child])
  const fields = child.fields.filter((f) => !f.readOnly && f.name !== column && (f.editable))
  const listFields = child.fields.filter((f) => f.list && f.name !== column)
  const label = (f: FieldMeta, v: unknown) => (v === null || v === undefined || v === '' ? '—' : f.kind === 'bool' ? (v ? 'Có' : 'Không') : f.kind === 'ref' ? (options[f.ref!]?.find((o) => o.id === Number(v))?.label ?? String(v)) : f.kind === 'enum' ? enumText(String(v)) : String(v))
  const save = async () => {
    if (!editing) return
    setBusy(true); setError('')
    try {
      const input: Row = {}
      for (const f of fields) {
        const v = editing.form[f.name]
        if (editing.id === null) { if (v !== undefined && v !== '' && !(v === null && !f.nullable)) input[f.name] = v } else if (JSON.stringify(v ?? null) !== JSON.stringify(items.find((r) => r.id === editing.id)?.[f.name] ?? null)) input[f.name] = v === undefined ? null : v
      }
      if (editing.id === null) await api.create(child.key, { ...input, [column]: parentId })
      else if (Object.keys(input).length) await api.update(child.key, editing.id, undefined, input)
      setEditing(null); setReload((n) => n + 1); toast.success('Đã lưu.')
    } catch (e) { setError(errorText(e, Object.fromEntries(child.fields.map((f) => [f.name, f.label])))) } finally { setBusy(false) }
  }
  return (
    <Section title={`${child.label} (${items.length})`}>
      <div className="grid gap-4" aria-busy={busy}>
        {items.length > 0 && <div className="overflow-x-auto rounded-md border"><Table><TableHeader className="bg-muted/40"><TableRow className="hover:bg-transparent">{listFields.map((f) => <TableHead key={f.name}>{f.label}</TableHead>)}<TableHead className="w-32" /></TableRow></TableHeader><TableBody>
          {items.map((row) => <TableRow key={String(row.id)}>{listFields.map((f) => <TableCell key={f.name} className="max-w-64 truncate">{label(f, row[f.name])}</TableCell>)}<TableCell className="text-right">
            <div className="flex justify-end gap-1.5">
              {child.canUpdate && <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => setEditing({ id: Number(row.id), form: { ...row } })}>Sửa</Button>}
              {child.canDelete && <Button type="button" size="xs" variant="outline" className="text-destructive hover:text-destructive" disabled={busy} onClick={async () => { if (await confirm({ title: 'Xóa mục này?', confirmLabel: 'Xóa', destructive: true })) { setBusy(true); api.remove(child.key, Number(row.id), undefined).then(() => setReload((n) => n + 1)).catch((e) => setError(errorText(e))).finally(() => setBusy(false)) } }}>Xóa</Button>}
            </div>
          </TableCell></TableRow>)}</TableBody></Table></div>}
        {!items.length && !editing && <p className="text-sm text-muted-foreground">Chưa có dữ liệu.</p>}
        {editing && (
          <div className="grid gap-4 rounded-lg border bg-muted/30 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {fields.map((f) => (
                <div key={f.name} className={f.kind === 'bool' ? 'flex items-center gap-2.5' : 'grid content-start gap-2'}>
                  {f.kind === 'bool' && <SimpleInput field={f} value={editing.form[f.name]} options={[]} disabled={busy} onChange={(v) => setEditing({ ...editing, form: { ...editing.form, [f.name]: v } })} />}
                  <Label htmlFor={`c-${f.name}`} className={f.kind === 'bool' ? 'font-normal' : undefined}>{f.label}{f.required && <span className="text-destructive"> *</span>}</Label>
                  {f.kind !== 'bool' && <SimpleInput field={f} value={editing.form[f.name]} options={options[f.ref ?? ''] ?? []} disabled={busy || (editing.id !== null && f.createOnly === true)} onChange={(v) => setEditing({ ...editing, form: { ...editing.form, [f.name]: v } })} />}
                </div>))}
            </div>
            <div className="flex gap-2"><Button type="button" size="sm" disabled={busy} onClick={save}>{editing.id === null ? 'Thêm' : 'Lưu'}</Button><Button type="button" size="sm" variant="outline" onClick={() => setEditing(null)}>Hủy</Button></div>
          </div>)}
        {!editing && child.canCreate && <div><Button type="button" size="sm" variant="outline" onClick={() => setEditing({ id: null, form: Object.fromEntries(child.fields.filter((f) => f.initial !== undefined).map((f) => [f.name, f.initial])) })}><Plus />Thêm {child.label.toLowerCase()}</Button></div>}
        {error && <Alert>{error}</Alert>}
      </div>
    </Section>
  )
}

/** Variant group of a product: members, link another product (search by name/SKU), unlink. */
function Variants({ productId, canEdit }: { productId: number; canEdit: boolean }) {
  const confirm = useConfirm()
  const [data, setData] = useState<{ group: string | null; items: { id: number; sku: string; name: string; price: number | null; color_name: string | null }[] }>({ group: null, items: [] })
  const [q, setQ] = useState(''); const [term, setTerm] = useState(''); const [found, setFound] = useState<Row[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [reload, setReload] = useState(0)
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t) }, [q])
  useEffect(() => { let live = true; api.variants(productId).then((d) => { if (live) setData(d) }).catch((e) => { if (live) setError(errorText(e)) }); return () => { live = false } }, [productId, reload])
  useEffect(() => {
    let live = true
    if (term.length >= 2) api.list('products', { q: term, limit: 8 }).then((r) => { if (live) setFound(r.items.filter((p) => Number(p.id) !== productId)) }).catch(() => undefined)
    return () => { live = false }
  }, [term, productId])
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); setReload((n) => n + 1); setFound([]); setQ('') } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }
  return (
    <Section title={`Biến thể${data.group ? ` (${data.group})` : ''}`}>
      <div className="grid gap-4" aria-busy={busy}>
        {data.items.length ? <div className="overflow-x-auto rounded-md border"><Table><TableHeader className="bg-muted/40"><TableRow className="hover:bg-transparent"><TableHead>SKU</TableHead><TableHead>Tên</TableHead><TableHead>Màu</TableHead><TableHead>Giá</TableHead><TableHead className="w-20" /></TableRow></TableHeader><TableBody>
          {data.items.map((v) => <TableRow key={v.id}><TableCell>{v.sku}</TableCell><TableCell className="max-w-64 truncate">{v.name}</TableCell><TableCell>{v.color_name ?? '—'}</TableCell><TableCell className="tabular-nums">{money(v.price)}</TableCell>
            <TableCell className="text-right">{canEdit && v.id !== productId && <Button type="button" size="xs" variant="outline" className="text-destructive hover:text-destructive" disabled={busy} onClick={async () => { if (await confirm({ title: 'Gỡ khỏi nhóm biến thể?', description: 'Sản phẩm này sẽ không còn thuộc nhóm biến thể.', confirmLabel: 'Gỡ', destructive: true })) void run(() => api.unlinkVariant(productId, v.id)) }}>Gỡ</Button>}</TableCell></TableRow>)}</TableBody></Table></div> : <p className="text-sm text-muted-foreground">Chưa thuộc nhóm biến thể nào.</p>}
        {canEdit && <div className="grid gap-2"><div className="relative max-w-md"><Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" /><Input type="search" className="pl-8" aria-label="Tìm sản phẩm để liên kết biến thể" placeholder="Tìm theo tên hoặc SKU (từ 2 ký tự)" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          {found.map((p) => <div key={String(p.id)} className="flex max-w-md items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"><span className="min-w-0 truncate">{String(p.sku)} — {String(p.name)}</span><Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void run(() => api.linkVariant(productId, Number(p.id)))}>Liên kết</Button></div>)}</div>}
        {error && <Alert>{error}</Alert>}
      </div>
    </Section>
  )
}
