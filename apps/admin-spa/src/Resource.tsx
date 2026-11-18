// Generic CRUD screens driven by the resource metadata served by the function (/schema). The server is the single
// source of truth for fields, validation limits, permissions and options; this file only renders them.
import { lazy, Suspense, useEffect, useState } from 'react'
import { api, ApiError, errorText, uploadImage, type FieldMeta, type ResourceMeta, type Row } from './api'

const RichText = lazy(() => import('./RichText'))
const BASE = '/admin-next'

export const slugify = (input: string) => String(input).replace(/[đĐ]/g, 'd').normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')

function Cell({ field, value }: { field: FieldMeta; value: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>
  switch (field.kind) {
    case 'bool': return <>{value ? 'Có' : 'Không'}</>
    case 'datetime': return <>{new Date(String(value)).toLocaleString('vi-VN')}</>
    case 'media': return <img src={String(value)} alt="" width={40} height={40} className="thumb" />
    case 'strings': return <>{(value as string[]).join(', ')}</>
    default: return <>{String(value)}</>
  }
}

export function ResourceList({ meta, go }: { meta: ResourceMeta; go: (to: string) => void }) {
  const [q, setQ] = useState(''); const [term, setTerm] = useState(''); const [page, setPage] = useState(1); const [filters, setFilters] = useState<Record<string, string>>({})
  const [data, setData] = useState<{ items: Row[]; total: number }>({ items: [], total: 0 }); const [error, setError] = useState(''); const [loadedFor, setLoadedFor] = useState('')
  const [selected, setSelected] = useState<Set<number>>(() => new Set()); const [notice, setNotice] = useState(''); const [reload, setReload] = useState(0)
  const filterKey = JSON.stringify(filters); const requestKey = `${term}|${page}|${filterKey}`; const loading = loadedFor !== requestKey
  useEffect(() => { const t = setTimeout(() => { setTerm(q.trim()); setPage(1) }, 300); return () => clearTimeout(t) }, [q])
  useEffect(() => {
    let live = true; const key = `${term}|${page}|${filterKey}`
    api.list(meta.key, { q: term, page, limit: 20, ...(JSON.parse(filterKey) as Record<string, string>) })
      .then((r) => { if (live) { setData({ items: r.items, total: r.total }); setError(''); setLoadedFor(key) } })
      .catch((err) => { if (live) { setError(errorText(err)); setLoadedFor(key) } })
    return () => { live = false }
  }, [meta.key, term, page, filterKey, reload])
  const columns = meta.fields.filter((f) => f.list); const pages = Math.max(1, Math.ceil(data.total / 20))
  const bulk = meta.key === 'products' && meta.canUpdate
  const runBulk = async (action: string) => {
    if (!selected.size) return
    if (action === 'delete' && !window.confirm(`Xóa ${selected.size} sản phẩm? Thao tác không thể hoàn tác.`)) return
    try {
      const result = await api.bulkProducts([...selected], action)
      setNotice(`Đã cập nhật ${result.updated} sản phẩm${result.skipped.length ? `; bỏ qua ${result.skipped.length} (${[...new Set(result.skipped.map((s) => errorText(new ApiError(400, s.reason))))].join(' ')})` : '.'}`)
      setSelected(new Set()); setReload((n) => n + 1)
    } catch (err) { setError(errorText(err)) }
  }
  return (
    <section className="card">
      <div className="bar">
        <h1>{meta.label} ({data.total})</h1>
        {meta.canCreate && <button onClick={() => go(`/r/${meta.key}/new`)}>+ Thêm mới</button>}
      </div>
      <div className="bar">
        {meta.searchable && <input type="search" aria-label="Tìm kiếm" placeholder="Tìm kiếm" value={q} onChange={(e) => setQ(e.target.value)} />}
        {meta.filters.map((f) => (
          <label key={f.name} className="inline">{f.label}
            <select value={filters[f.name] ?? ''} onChange={(e) => { setFilters({ ...filters, [f.name]: e.target.value }); setPage(1) }}>
              <option value="">Tất cả</option>
              {f.kind === 'bool' ? <><option value="true">Có</option><option value="false">Không</option></> : (f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
        ))}
      </div>
      {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="ok">{notice}</p>}
      {bulk && <div className="bar" role="toolbar" aria-label="Thao tác hàng loạt"><span className="muted">Đã chọn {selected.size}</span>
        {[['activate', 'Bán'], ['deactivate', 'Ngừng bán'], ['feature', 'Nổi bật'], ['unfeature', 'Bỏ nổi bật']].map(([a, l]) => <button key={a} type="button" disabled={!selected.size} onClick={() => runBulk(a)}>{l}</button>)}
        {meta.canDelete && <button type="button" className="danger" disabled={!selected.size} onClick={() => runBulk('delete')}>Xóa</button>}</div>}
      <div className="scroll">
        <table>
          <thead><tr>{bulk && <th><input type="checkbox" aria-label="Chọn tất cả" checked={data.items.length > 0 && data.items.every((r) => selected.has(Number(r.id)))} onChange={(e) => setSelected(e.target.checked ? new Set(data.items.map((r) => Number(r.id))) : new Set())} /></th>}<th>ID</th>{columns.map((f) => <th key={f.name}>{f.label}</th>)}</tr></thead>
          <tbody>
            {data.items.map((row) => (
              <tr key={String(row.id)}>
                {bulk && <td><input type="checkbox" aria-label={`Chọn ${row.id}`} checked={selected.has(Number(row.id))} onChange={(e) => setSelected((cur) => { const next = new Set(cur); if (e.target.checked) next.add(Number(row.id)); else next.delete(Number(row.id)); return next })} /></td>}
                <td><a href={`${BASE}/r/${meta.key}/${row.id}`} onClick={(e) => { e.preventDefault(); go(`/r/${meta.key}/${row.id}`) }}>{String(row.id)}</a></td>
                {columns.map((f, i) => <td key={f.name}>{i === 0
                  ? <a href={`${BASE}/r/${meta.key}/${row.id}`} onClick={(e) => { e.preventDefault(); go(`/r/${meta.key}/${row.id}`) }}><Cell field={f} value={row[f.name]} /></a>
                  : <Cell field={f} value={row[f.name]} />}</td>)}
              </tr>
            ))}
            {!data.items.length && !loading && <tr><td colSpan={columns.length + 1} className="muted">Không có dữ liệu.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="bar"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>Trước</button><span>Trang {page}/{pages}</span><button disabled={page >= pages} onClick={() => setPage(page + 1)}>Sau</button></div>
    </section>
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
      const before = f.kind === 'int' || f.kind === 'ref' ? (original[f.name] ?? null) : f.kind === 'strings' ? (original[f.name] ?? []) : f.kind === 'bool' ? Boolean(original[f.name]) : f.kind === 'json' ? (original[f.name] ?? {}) : (original[f.name] ?? '')
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

export function ResourceForm({ meta, id, go }: { meta: ResourceMeta; id: number | null; go: (to: string) => void }) {
  const creating = id === null
  const [original, setOriginal] = useState<Row | null>(null); const [form, setForm] = useState<Row>(() => initialRow(meta))
  const [options, setOptions] = useState<Record<string, Option[]>>({}); const [loaded, setLoaded] = useState(creating)
  const [jsonText, setJsonText] = useState<Record<string, string>>({}); const [jsonError, setJsonError] = useState<Record<string, boolean>>({})
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [touched, setTouched] = useState<Set<string>>(() => new Set())
  const labels = Object.fromEntries([...meta.fields.map((f) => [f.name, f.label]), ...meta.relations.map((r) => [r.input, r.label])])
  const canEdit = creating ? meta.canCreate : meta.canUpdate
  useEffect(() => {
    let live = true
    if (id !== null) api.get(meta.key, id).then((row) => { if (live) { setOriginal(row); setForm(row); setLoaded(true) } }).catch((err) => { if (live) setError(errorText(err)) })
    const refs = [...new Set([...meta.fields.filter((f) => f.kind === 'ref').map((f) => f.ref!), ...meta.relations.map((r) => r.ref)])]
    for (const ref of refs) api.options(ref).then((items) => { if (live) setOptions((o) => ({ ...o, [ref]: items })) }).catch(() => undefined)
    return () => { live = false }
  }, [meta, id])
  if (!loaded) return <section className="card">{error ? <p role="alert" className="error">{error}</p> : <p className="muted">Đang tải…</p>}</section>

  const set = (name: string, value: unknown) => setForm((f) => {
    const next: Row = { ...f, [name]: value }
    if (creating) for (const field of meta.fields) if (field.slugFrom === name && !touched.has(field.name)) next[field.name] = slugify(String(value))
    return next
  })
  const input = (f: FieldMeta) => {
    const value = form[f.name]; const disabled = !canEdit || !f.editable || f.readOnly || busy || (!creating && f.createOnly === true)
    const common = { id: `f-${f.name}`, disabled }
    switch (f.kind) {
      case 'textarea': return <textarea {...common} rows={4} maxLength={f.max} value={String(value ?? '')} onChange={(e) => set(f.name, e.target.value)} />
      case 'html': return <Suspense fallback={<p className="muted">Đang tải trình soạn thảo…</p>}><RichText value={String(value ?? '')} disabled={disabled} folder={meta.key === 'products' ? 'products' : 'blog'} onChange={(html) => set(f.name, html)} /></Suspense>
      case 'int': return <input {...common} type="number" min={f.min} max={f.max} value={value === null || value === undefined ? '' : String(value)} onChange={(e) => set(f.name, e.target.value)} />
      case 'bool': return <input {...common} type="checkbox" checked={Boolean(value)} onChange={(e) => set(f.name, e.target.checked)} />
      case 'enum': return <select {...common} value={String(value ?? '')} onChange={(e) => set(f.name, e.target.value)}>{creating && <option value="">—</option>}{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>
      case 'ref': return <select {...common} value={value === null || value === undefined ? '' : String(value)} onChange={(e) => set(f.name, e.target.value)}><option value="">— chọn —</option>{(options[f.ref!] ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
      case 'strings': return <input {...common} value={Array.isArray(value) ? (value as string[]).join(', ') : ''} onChange={(e) => set(f.name, e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
      case 'media': return (
        <div className="image">
          {value ? <img src={String(value)} alt="" width={96} height={96} /> : <div className="ph">Chưa có ảnh</div>}
          <div className="stack">
            <input {...common} type="url" placeholder="https://…" value={String(value ?? '')} onChange={(e) => set(f.name, e.target.value)} />
            <input type="file" aria-label={`Tải ảnh: ${f.label}`} accept="image/jpeg,image/png,image/webp,image/gif" disabled={disabled} onChange={async (e) => {
              const file = e.target.files?.[0]; e.target.value = ''; if (!file) return
              setBusy(true); setError('')
              try { set(f.name, await uploadImage(file, f.upload?.folder ?? 'blog', f.upload?.profile ?? 'editorial')); setMessage('Đã tải ảnh lên. Nhấn Lưu để áp dụng.') } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
            }} />
          </div>
        </div>)
      case 'json': return <textarea {...common} rows={5} spellCheck={false} className="mono" value={jsonText[f.name] ?? JSON.stringify(value ?? {}, null, 2)} onChange={(e) => {
        const text = e.target.value; setJsonText((j) => ({ ...j, [f.name]: text }))
        try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { set(f.name, parsed); setJsonError((j) => ({ ...j, [f.name]: false })) } else throw new Error('shape') } catch { setJsonError((j) => ({ ...j, [f.name]: true })) }
      }} />
      case 'password': return <input {...common} type="password" autoComplete="new-password" minLength={8} maxLength={f.max ?? 200} value={String(value ?? '')} onChange={(e) => set(f.name, e.target.value)} />
      case 'email': return <input {...common} type="email" autoComplete="off" maxLength={f.max} value={String(value ?? '')} onChange={(e) => set(f.name, e.target.value)} />
      case 'money': return <input {...common} type="number" min={f.min ?? 0} step="1" value={value === null || value === undefined ? '' : String(value)} onChange={(e) => set(f.name, e.target.value)} />
      case 'datetime': return <input {...common} disabled value={value ? new Date(String(value)).toLocaleString('vi-VN') : ''} readOnly />
      default: return <input {...common} type={f.kind === 'link' ? 'text' : 'text'} maxLength={f.max} value={String(value ?? '')} onChange={(e) => { if (f.slugFrom) setTouched((t) => new Set(t).add(f.name)); set(f.name, e.target.value) }} />
    }
  }
  const version = original && meta.versioned ? Number(original.version) : undefined
  return (
    <form className="card" onSubmit={async (e) => {
      e.preventDefault(); setMessage(''); setError('')
      const badJson = meta.fields.filter((f) => jsonError[f.name]).map((f) => f.label)
      if (badJson.length) { setError(`JSON không hợp lệ: ${badJson.join(', ')}.`); return }
      setBusy(true)
      const body = buildInput(meta, form, original)
      if (!creating && !Object.keys(body).length) { setMessage('Không có thay đổi.'); setBusy(false); return }
      try {
        if (creating) { const row = await api.create(meta.key, body); go(`/r/${meta.key}/${row.id}`) }
        else { const row = await api.update(meta.key, id, version, body); setOriginal(row); setForm(row); setMessage('Đã lưu.') }
      } catch (err) { setError(errorText(err, labels)) } finally { setBusy(false) }
    }}>
      <div className="bar"><h1>{creating ? `Thêm: ${meta.label}` : `${meta.label} #${id}`}</h1><button type="button" onClick={() => go(`/r/${meta.key}`)}>← Danh sách</button></div>
      {meta.fields.filter((f) => !(creating && f.readOnly)).map((f) => (
        <div key={f.name} className={f.kind === 'bool' ? 'field check' : 'field'}>
          <label htmlFor={`f-${f.name}`}>{f.label}{f.required ? ' *' : ''}</label>
          {input(f)}
        </div>
      ))}
      {meta.relations.map((r) => (
        <fieldset key={r.input} className="field" disabled={!canEdit || busy}>
          <legend>{r.label}</legend>
          <div className="chips">
            {(options[r.ref] ?? []).map((o) => {
              const selected = (Array.isArray(form[r.input]) ? form[r.input] as number[] : []).includes(o.id)
              return <label key={o.id} className="check chip"><input type="checkbox" checked={selected} onChange={(e) => {
                const current = Array.isArray(form[r.input]) ? form[r.input] as number[] : []
                set(r.input, e.target.checked ? [...current, o.id] : current.filter((x) => x !== o.id))
              }} />{o.label}</label>
            })}
            {!(options[r.ref] ?? []).length && <span className="muted">Chưa có mục nào.</span>}
          </div>
        </fieldset>
      ))}
      {error && <p role="alert" className="error">{error}</p>}{message && <p role="status" className="ok">{message}</p>}
      {meta.key === 'products' && !creating && <Gallery productId={id} canEdit={meta.canUpdate} mainUrl={String(form.image_main_url ?? '')} onSetMain={(url) => set('image_main_url', url)} />}
      <div className="bar">
        {canEdit ? <button disabled={busy}>{busy ? 'Đang xử lý…' : creating ? 'Tạo' : 'Lưu'}</button> : <p className="muted">Vai trò của bạn chỉ có quyền xem.</p>}
        {!creating && meta.canDelete && <button type="button" className="danger" disabled={busy} onClick={async () => {
          if (!window.confirm('Xóa mục này? Thao tác không thể hoàn tác.')) return
          setBusy(true); setError('')
          try { await api.remove(meta.key, id, version); go(`/r/${meta.key}`) } catch (err) { setError(errorText(err)); setBusy(false) }
        }}>Xóa</button>}
      </div>
    </form>
  )
}

/** Product gallery (product_images): upload through the legacy route, order, delete, promote to main image. */
function Gallery({ productId, canEdit, mainUrl, onSetMain }: { productId: number; canEdit: boolean; mainUrl: string; onSetMain: (url: string) => void }) {
  const [items, setItems] = useState<Row[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [reload, setReload] = useState(0)
  useEffect(() => {
    let live = true
    api.list('product-images', { product_id: productId, limit: 50 }).then((r) => { if (live) setItems(r.items) }).catch((e) => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [productId, reload])
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); try { await fn(); setReload((n) => n + 1) } catch (e) { setError(errorText(e)) } finally { setBusy(false) } }
  return (
    <fieldset className="field gallery" disabled={busy}>
      <legend>Thư viện ảnh</legend>
      <div className="chips">
        {items.map((img) => (
          <figure key={String(img.id)} className="shot">
            <img src={String(img.image_url)} alt={String(img.alt_text ?? '')} width={96} height={96} />
            <figcaption>
              <input type="number" aria-label="Thứ tự" disabled={!canEdit} defaultValue={Number(img.sort_order ?? 0)} onBlur={(e) => { const next = Number(e.target.value); if (Number.isInteger(next) && next !== Number(img.sort_order)) void run(() => api.update('product-images', Number(img.id), undefined, { sort_order: next })) }} />
              {canEdit && <><button type="button" disabled={mainUrl === img.image_url} onClick={() => onSetMain(String(img.image_url))}>Ảnh chính</button>
                <button type="button" className="danger" onClick={() => { if (window.confirm('Xóa ảnh này?')) void run(() => api.remove('product-images', Number(img.id), undefined)) }}>Xóa</button></>}
            </figcaption>
          </figure>))}
        {!items.length && <span className="muted">Chưa có ảnh trong thư viện.</span>}
      </div>
      {canEdit && <input type="file" aria-label="Thêm ảnh vào thư viện" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(e) => {
        const file = e.target.files?.[0]; e.target.value = ''; if (!file) return
        void run(async () => { const url = await uploadImage(file, 'products', 'product'); await api.create('product-images', { product_id: productId, image_url: url, sort_order: items.length }) })
      }} />}
      <p className="muted">Ảnh chính được lưu cùng sản phẩm: chọn «Ảnh chính» rồi nhấn Lưu.</p>
      {error && <p role="alert" className="error">{error}</p>}
    </fieldset>
  )
}
