export type Role = 'admin' | 'sale_manager' | 'sale'
export type User = { id: number; email: string; name: string; role: Role }
export type ProductRow = { id: number; sku: string; name: string; slug: string; is_active: boolean; publication_status: string; pdp_visibility: string; image_main_url: string | null; version: number; updated_at: string }
export type Product = ProductRow & {
  display_name: string | null; description: string | null; is_featured: boolean; listing_visibility: string
  seo_title: string | null; seo_description: string | null; price_display: string | null
  category_name: string; subcategory_name: string | null; brand_name: string | null
}
export type Row = Record<string, unknown>
export type FieldMeta = {
  name: string; label: string; kind: 'text' | 'textarea' | 'html' | 'int' | 'bool' | 'enum' | 'link' | 'media' | 'datetime' | 'strings' | 'ref' | 'json' | 'password' | 'money' | 'email'
  required: boolean; max?: number; min?: number; options?: string[]; ref?: string; readOnly: boolean; list: boolean; slugFrom?: string; initial?: unknown
  nullable: boolean; editable: boolean; upload?: { folder: string; profile: string }
}
export type ResourceMeta = {
  key: string; label: string; group: string; inNav: boolean; canCreate: boolean; canUpdate: boolean; canDelete: boolean; versioned: boolean; searchable: boolean
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
  products: (q: string, page: number) => request<{ items: ProductRow[]; total: number; page: number; limit: number }>('GET', `/products?limit=20&page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  product: (id: number) => request<Product>('GET', `/products/${id}`),
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
  saveProduct: (id: number, expected_version: number, input: Record<string, unknown>) => request<Product>('PATCH', `/products/${id}`, { expected_version, input }),
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
  PUBLISHING_MANAGED: 'Nội dung/ảnh của bài do Publishing Agent tạo chỉ được đổi qua Publishing API.',
  METHOD_NOT_ALLOWED: 'Thao tác không được hỗ trợ.', ADMIN_API_NOT_CONFIGURED: 'Dịch vụ quản trị chưa được cấu hình.',
}
export const errorText = (error: unknown, labels: Record<string, string> = {}) => {
  if (!(error instanceof ApiError)) return 'Không thể kết nối. Vui lòng thử lại.'
  const base = ERROR_TEXT[error.code] ?? `Lỗi (${error.code}).`
  const named = error.fields.map((name) => labels[name] ?? name)
  return named.length ? `${base} Kiểm tra: ${named.join(', ')}.` : base
}
