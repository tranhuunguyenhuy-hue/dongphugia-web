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
  METHOD_NOT_ALLOWED: 'Thao tác không được hỗ trợ.', LAST_ADMIN: 'Không thể vô hiệu hóa hoặc hạ quyền Quản trị viên cuối cùng.',
  PRICE_REQUIRED: 'Sản phẩm cần có giá trước khi kích hoạt.', IMAGE_REQUIRED: 'Sản phẩm cần có ảnh chính trước khi kích hoạt.', SALE_PRICE_INVALID: 'Giá khuyến mãi phải nhỏ hơn giá niêm yết.', ADMIN_API_NOT_CONFIGURED: 'Dịch vụ quản trị chưa được cấu hình.',
}
export const errorText = (error: unknown, labels: Record<string, string> = {}) => {
  if (!(error instanceof ApiError)) return 'Không thể kết nối. Vui lòng thử lại.'
  const base = ERROR_TEXT[error.code] ?? `Lỗi (${error.code}).`
  const named = error.fields.map((name) => labels[name] ?? name)
  return named.length ? `${base} Kiểm tra: ${named.join(', ')}.` : base
}

// ---- orders / quotes / dashboard (dedicated function handlers) ----
export type Money = number | null
export type OrderRow = { id: number; order_number: string; customer_name: string; customer_phone: string; total: Money; status: string; payment_status: string; payment_method: string | null; created_at: string; assigned_to: number | null; assigned_name: string | null; item_count: number }
export type OrderItem = { id: number; product_id: number; product_name: string; product_sku: string; quantity: number; unit_price: Money; total_price: Money; image_main_url: string | null }
export type OrderDetail = Omit<OrderRow, 'item_count'> & { customer_email: string | null; customer_address: string | null; note: string | null; subtotal: Money; shipping_fee: Money; discount: Money; vat_rate: number; items: OrderItem[] }
export type QuoteRow = { id: number; quote_number: string | null; name: string; phone: string; email: string | null; status: string; created_at: string; assigned_to: number | null; assigned_name: string | null; item_names: string }
export type QuoteItem = { id: number; product_id: number; quantity: number; note: string | null; admin_quantity: number | null; admin_unit_price: Money; product_name_snapshot: string | null; product_sku_snapshot: string | null; snapshot_at: string | null; list_price_snapshot: Money; sale_price_snapshot: Money; product_name: string | null; product_sku: string | null; product_price: Money }
export type QuoteDetail = { id: number; quote_number: string | null; name: string; phone: string; email: string | null; message: string | null; status: string; admin_notes: string | null; shipping_fee: Money; vat_rate: number; assigned_to: number | null; items: QuoteItem[] }
export type Dashboard = {
  stats: { pending_quotes: number; pending_orders: number; revenue_this_month: number; revenue_last_month: number; revenue_growth: number | null; orders_this_month: number; total_products: number; active_products: number }
  period: string; revenue: { date: string; revenue: number; order_count: number }[]
  pending_quotes: { id: number; quote_number: string | null; name: string; phone: string; created_at: string; item_names: string }[]
  pending_orders: { id: number; order_number: string; customer_name: string; customer_phone: string; total: Money; payment_status: string; created_at: string }[]
  top_sold: { product_id: number; product_name: string; product_sku: string; total_sold: number }[]; top_quoted: { product_id: number; name: string; sku: string; quote_count: number }[]
}
export const commerce = {
  assignees: () => request<{ items: { id: number; name: string; role: string }[] }>('GET', '/assignees').then((r) => r.items),
  dashboard: (period: string) => request<Dashboard>('GET', `/dashboard?period=${period}`),
  orders: (params: Record<string, string | number>) => request<{ items: OrderRow[]; total: number; stats: { total: number; pending: number; processing: number; completed: number; revenue: number } }>('GET', `/orders?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '').map(([k, v]) => [k, String(v)]))}`),
  order: (id: number) => request<OrderDetail>('GET', `/orders/${id}`),
  orderStatus: (id: number, status: string) => request<OrderDetail>('PATCH', `/orders/${id}/status`, { status }),
  orderPayment: (id: number, payment_status: string) => request<OrderDetail>('PATCH', `/orders/${id}/payment`, { payment_status }),
  orderAssign: (id: number, user_id: number | null) => request<OrderDetail>('PATCH', `/orders/${id}/assign`, { user_id }),
  orderSave: (id: number, body: Row) => request<OrderDetail>('PATCH', `/orders/${id}`, body),
  quotes: (params: Record<string, string | number>) => request<{ items: QuoteRow[]; total: number; counts: Record<string, number> }>('GET', `/quotes?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '').map(([k, v]) => [k, String(v)]))}`),
  quote: (id: number) => request<QuoteDetail>('GET', `/quotes/${id}`),
  quoteStatus: (id: number, status: string) => request<QuoteDetail>('PATCH', `/quotes/${id}/status`, { status }),
  quoteAssign: (id: number, user_id: number | null) => request<QuoteDetail>('PATCH', `/quotes/${id}/assign`, { user_id }),
  quoteSave: (id: number, body: Row) => request<QuoteDetail>('PATCH', `/quotes/${id}`, body),
  quoteComplete: (id: number, body: Row) => request<QuoteDetail>('POST', `/quotes/${id}/complete`, body),
}
