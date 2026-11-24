export type Role = 'admin' | 'sale_manager' | 'sale'
export type User = { id: number; email: string; name: string; role: Role; permissions: string[] }
export const can = (user: User, permission: string) => user.permissions.includes('*') || user.permissions.includes(permission)
export type Row = Record<string, unknown>
export type FieldMeta = {
  name: string; label: string; kind: 'text' | 'textarea' | 'html' | 'int' | 'bool' | 'enum' | 'link' | 'media' | 'datetime' | 'strings' | 'ref' | 'json' | 'password' | 'money' | 'email' | 'url'
  required: boolean; max?: number; min?: number; options?: string[]; ref?: string; readOnly: boolean; createOnly?: boolean; list: boolean; slugFrom?: string; initial?: unknown
  nullable: boolean; editable: boolean; upload?: { folder: string; profile: string }
}
export type ResourceMeta = {
  key: string; label: string; group: string; children?: { key: string; column: string }[]; inNav: boolean; canCreate: boolean; canUpdate: boolean; canDelete: boolean; versioned: boolean; searchable: boolean
  fields: FieldMeta[]; relations: { input: string; label: string; ref: string }[]
  filters: { name: string; label: string; kind: 'bool' | 'int' | 'enum'; options?: string[] }[]
}
export class ApiError extends Error { constructor(readonly status: number, readonly code: string, readonly fields: string[] = []) { super(code) } }

const BASE = '/admin-next/api'
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(BASE + path, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(response.status, payload?.error?.code ?? 'UNKNOWN', Array.isArray(payload?.error?.fields) ? payload.error.fields : [])
  return payload.data as T
}

export const api = {
  me: () => request<User>('GET', '/me'),
  login: (email: string, password: string) => request<{ user: User; expires_at: string }>('POST', '/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/logout', {}),
  schema: () => request<{ resources: ResourceMeta[] }>('GET', '/schema').then((r) => r.resources),
  list: (key: string, params: Record<string, string | number | boolean | undefined>) => {
    const search = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') search.set(k, String(v))
    return request<{ items: Row[]; total: number; page: number; limit: number }>('GET', `/r/${key}?${search}`)
  },
  options: (key: string) => request<{ items: { id: number; label: string }[] }>('GET', `/r/${key}/options`).then((r) => r.items),
  get: (key: string, id: number) => request<Row>('GET', `/r/${key}/${id}`),
  create: (key: string, input: Row) => request<Row>('POST', `/r/${key}`, { input }),
  update: (key: string, id: number, expected_version: number | undefined, input: Row) => request<Row>('PATCH', `/r/${key}/${id}`, { ...(expected_version === undefined ? {} : { expected_version }), input }),
  remove: (key: string, id: number, expected_version: number | undefined) => request<{ ok: true; result: string }>('DELETE', `/r/${key}/${id}`, expected_version === undefined ? {} : { expected_version }),
  variants: (id: number) => request<{ group: string | null; items: { id: number; sku: string; name: string; price: number | null; image_main_url: string | null; color_name: string | null }[] }>('GET', `/products/${id}/variants`),
  linkVariant: (id: number, target_id: number) => request<{ group: string }>('POST', `/products/${id}/variants`, { target_id }),
  unlinkVariant: (id: number, target_id: number) => request<{ ok: true }>('DELETE', `/products/${id}/variants/${target_id}`, {}),
  bulkProducts: (ids: number[], action: string) => request<{ updated: number; skipped: { id: number; reason: string }[] }>('POST', '/products/bulk', { ids, action }),
}

// Display-only media host mapping. Stored URLs are never rewritten: the legacy product CDN hostname has a TLS renewal problem,
// while the same paths are served by the verified default pull zone. Only that exact https host is mapped.
const LEGACY_MEDIA_HOST = 'cdn.dongphugia.com.vn'
const DEFAULT_MEDIA_HOST = 'dpg-products.b-cdn.net'
export function displayMediaUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value : value == null ? '' : String(value)
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:' && url.hostname === LEGACY_MEDIA_HOST && url.port === '' && !url.username && !url.password) {
      url.hostname = DEFAULT_MEDIA_HOST
      return url.toString()
    }
  } catch { /* not an absolute URL: show as stored */ }
  return raw
}

// Legacy upload route (Cloudflare Images transform + isolated Bunny target): the transform contract is unchanged.
export async function uploadImage(file: File, folder = 'products', profile = 'product'): Promise<string> {
  const form = new FormData(); form.set('file', file); form.set('folder', folder); form.set('profile', profile)
  const response = await fetch('/api/upload-image', { method: 'POST', body: form, credentials: 'same-origin' })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || typeof payload.url !== 'string') throw new ApiError(response.status, payload?.error ?? 'UPLOAD_FAILED')
  return payload.url
}

export const ERROR_TEXT: Record<string, string> = {
  INVALID_CREDENTIALS: 'Email hoặc mật khẩu không đúng.', RATE_LIMITED: 'Thử quá nhiều lần. Vui lòng đợi 15 phút.',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết hạn.', FORBIDDEN: 'Bạn không có quyền thực hiện thao tác này.',
  VERSION_CONFLICT: 'Dữ liệu đã được người khác cập nhật. Hãy tải lại trang.', VALIDATION_FAILED: 'Dữ liệu không hợp lệ.',
  NOT_FOUND: 'Không tìm thấy.', DUPLICATE: 'Giá trị bị trùng (ví dụ slug đã tồn tại).', REFERENCE_CONFLICT: 'Dữ liệu liên kết không hợp lệ hoặc đang được sử dụng.',
  DEV_MANAGED: 'Dữ liệu danh mục dùng chung do bộ phận kỹ thuật quản lý, không chỉnh sửa tại Quản trị.', PUBLISHING_MANAGED: 'Nội dung/ảnh của bài do Publishing Agent tạo chỉ được đổi qua Publishing API.',
  METHOD_NOT_ALLOWED: 'Thao tác không được hỗ trợ.', LAST_ADMIN: 'Không thể vô hiệu hóa hoặc hạ quyền Quản trị viên cuối cùng.',
  PRICE_REQUIRED: 'Sản phẩm cần có giá trước khi kích hoạt.', IMAGE_REQUIRED: 'Sản phẩm cần có ảnh chính trước khi kích hoạt.', SALE_PRICE_INVALID: 'Giá khuyến mãi phải nhỏ hơn giá niêm yết.', ADMIN_API_NOT_CONFIGURED: 'Dịch vụ quản trị chưa được cấu hình.',
}
export const errorText = (error: unknown, labels: Record<string, string> = {}) => {
  if (!(error instanceof ApiError)) return 'Không thể kết nối. Vui lòng thử lại.'
  const base = ERROR_TEXT[error.code] ?? `Lỗi (${error.code}).`
  const named = error.fields.map((name) => labels[name] ?? name)
  return named.length ? `${base} Kiểm tra: ${named.join(', ')}.` : base
}

// ---- commerce v1 inbox (dpg_commerce) + dashboard (dedicated function handlers) ----
export type Money = number | null
export type SalesKind = 'orders' | 'quotes'
export type SalesStatus = 'new' | 'processing' | 'done' | 'cancelled'
export type SalesRow = { id: number; code: string; status: SalesStatus; customer_name: string; customer_phone: string; total_vnd?: Money; line_count: number; assigned_to: number | null; created_at: string; updated_at: string }
export type SalesLine = { line_no: number; product_id: number; sku: string; product_name: string; brand: string | null; quantity: number; regular_vnd?: Money; unit_selling_vnd: Money; unit_voucher_vnd?: Money; line_subtotal_vnd?: Money; line_voucher_vnd?: Money; reason?: string }
export type SalesDetail = SalesRow & { customer_email: string | null; note: string | null; staff_note: string | null; version: number; delivery_address?: string; subtotal_vnd?: Money; voucher_vnd?: Money; assigned_name: string | null; lines: SalesLine[]; events: { actor: string; action: string; from_status: string | null; to_status: string | null; at: string }[] }
export type Dashboard = {
  scope: 'all' | 'own'
  stats: { new_orders: number; new_quotes: number; processing_orders: number; processing_quotes: number; total_products: number | null; active_products: number | null }
  new_orders: { id: number; code: string; customer_name: string; customer_phone: string; total_vnd: Money; line_count: number; created_at: string }[]
  new_quotes: { id: number; code: string; customer_name: string; customer_phone: string; line_count: number; created_at: string }[]
}
export const commerce = {
  assignees: () => request<{ items: { id: number; name: string; role: string }[] }>('GET', '/assignees').then((r) => r.items),
  dashboard: () => request<Dashboard>('GET', '/dashboard'),
  list: (kind: SalesKind, params: Record<string, string | number>) => request<{ items: SalesRow[]; total: number; counts: Record<SalesStatus, number> }>('POST', `/sales/${kind}/list`, Object.fromEntries(Object.entries(params).filter(([, v]) => v !== ''))),   // POST body: search terms (phones) never go in a URL
  get: (kind: SalesKind, id: number) => request<SalesDetail>('GET', `/sales/${kind}/${id}`),
  setStatus: (kind: SalesKind, id: number, status: Exclude<SalesStatus, 'new'>, expected_version: number, note?: string) => request<SalesDetail>('POST', `/sales/${kind}/${id}/status`, { status, expected_version, ...(note ? { note } : {}) }),
  setNote: (kind: SalesKind, id: number, note: string, expected_version: number) => request<SalesDetail>('POST', `/sales/${kind}/${id}/note`, { note, expected_version }),
  assign: (kind: SalesKind, id: number, user_id: number | null, expected_version: number) => request<SalesDetail>('POST', `/sales/${kind}/${id}/assign`, { user_id, expected_version }),
}
