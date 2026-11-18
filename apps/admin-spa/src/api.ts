export type Role = 'admin' | 'sale_manager' | 'sale'
export type User = { id: number; email: string; name: string; role: Role }
export type ProductRow = { id: number; sku: string; name: string; slug: string; is_active: boolean; publication_status: string; pdp_visibility: string; image_main_url: string | null; version: number; updated_at: string }
export type Product = ProductRow & {
  display_name: string | null; description: string | null; is_featured: boolean; listing_visibility: string
  seo_title: string | null; seo_description: string | null; price_display: string | null
  category_name: string; subcategory_name: string | null; brand_name: string | null
}
export class ApiError extends Error { constructor(readonly status: number, readonly code: string) { super(code) } }

const BASE = '/admin-next/api'
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(BASE + path, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(response.status, payload?.error?.code ?? 'UNKNOWN')
  return payload.data as T
}

export const api = {
  me: () => request<User>('GET', '/me'),
  login: (email: string, password: string) => request<{ user: User; expires_at: string }>('POST', '/login', { email, password }),
  logout: () => request<{ ok: true }>('POST', '/logout', {}),
  products: (q: string, page: number) => request<{ items: ProductRow[]; total: number; page: number; limit: number }>('GET', `/products?limit=20&page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  product: (id: number) => request<Product>('GET', `/products/${id}`),
  saveProduct: (id: number, expected_version: number, input: Record<string, unknown>) => request<Product>('PATCH', `/products/${id}`, { expected_version, input }),
}

// Legacy upload route (Cloudflare Images transform + isolated Bunny target): the transform contract is unchanged.
export async function uploadImage(file: File): Promise<string> {
  const form = new FormData(); form.set('file', file); form.set('folder', 'products'); form.set('profile', 'product')
  const response = await fetch('/api/upload-image', { method: 'POST', body: form, credentials: 'same-origin' })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || typeof payload.url !== 'string') throw new ApiError(response.status, payload?.error ?? 'UPLOAD_FAILED')
  return payload.url
}

export const ERROR_TEXT: Record<string, string> = {
  INVALID_CREDENTIALS: 'Email hoặc mật khẩu không đúng.', RATE_LIMITED: 'Thử quá nhiều lần. Vui lòng đợi 15 phút.',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết hạn.', FORBIDDEN: 'Bạn không có quyền thực hiện thao tác này.',
  VERSION_CONFLICT: 'Sản phẩm đã được người khác cập nhật. Hãy tải lại trang.', VALIDATION_FAILED: 'Dữ liệu không hợp lệ.',
  NOT_FOUND: 'Không tìm thấy.', ADMIN_API_NOT_CONFIGURED: 'Dịch vụ quản trị chưa được cấu hình.',
}
export const errorText = (error: unknown) => (error instanceof ApiError ? ERROR_TEXT[error.code] ?? `Lỗi (${error.code}).` : 'Không thể kết nối. Vui lòng thử lại.')
