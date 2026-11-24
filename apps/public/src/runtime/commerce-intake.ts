// #470 COMMERCE V1 — guest cart check / order / quote intake. The Worker never reads or writes commerce tables: it connects with a login role that can only
// SET ROLE to `dpg_commerce_intake`, which has EXECUTE on three SECURITY DEFINER functions (supabase/commerce-v1/001_commerce_schema.sql).
// Prices, vouchers, totals and eligibility are decided by the database from the official canonical columns; nothing a client sends about them is read here
// (the client only echoes the total it SAW so that a change is detected). Closed (404) unless PUBLIC_COMMERCE=on AND the intake binding exists.
export type CommerceBinding = { connectionString: string }
export type CommerceClient = { query: (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; end: () => Promise<unknown> }
export type CommerceKind = 'cart' | 'orders' | 'quotes'
export const COMMERCE_BODY_LIMIT_BYTES = 16_384
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,100}$/
const FUNCTION_OF: Record<CommerceKind, string> = { cart: 'dpg_commerce.cart_check', orders: 'dpg_commerce.order_submit', quotes: 'dpg_commerce.quote_submit' }
// stable business errors from the database -> HTTP status + a Vietnamese message that never echoes input
const ERRORS: Record<string, { status: number; message: string }> = {
  INVALID_INPUT: { status: 400, message: 'Dữ liệu không hợp lệ. Vui lòng kiểm tra lại.' },
  INVALID_IDEMPOTENCY_KEY: { status: 400, message: 'Yêu cầu không hợp lệ. Vui lòng thử lại.' },
  INVALID_ITEMS: { status: 400, message: 'Giỏ hàng không hợp lệ.' },
  INVALID_ITEM: { status: 400, message: 'Sản phẩm trong giỏ hàng không hợp lệ.' },
  INVALID_QUANTITY: { status: 400, message: 'Số lượng không hợp lệ (1–99).' },
  DUPLICATE_PRODUCT: { status: 400, message: 'Mỗi sản phẩm chỉ xuất hiện một lần trong giỏ hàng.' },
  INVALID_CUSTOMER_NAME: { status: 400, message: 'Vui lòng nhập họ tên hợp lệ.' },
  INVALID_CUSTOMER_PHONE: { status: 400, message: 'Vui lòng nhập số điện thoại di động Việt Nam hợp lệ.' },
  INVALID_CUSTOMER_EMAIL: { status: 400, message: 'Email không hợp lệ.' },
  INVALID_DELIVERY_ADDRESS: { status: 400, message: 'Vui lòng nhập địa chỉ giao hàng đầy đủ.' },
  INVALID_NOTE: { status: 400, message: 'Ghi chú không hợp lệ hoặc quá dài.' },
  PRICE_CHANGED: { status: 409, message: 'Giá sản phẩm vừa thay đổi. Vui lòng kiểm tra lại tổng tiền và xác nhận.' },
  ITEMS_NOT_ORDERABLE: { status: 409, message: 'Một số sản phẩm không đặt mua trực tiếp được. Vui lòng gửi yêu cầu báo giá cho các sản phẩm đó.' },
  PRODUCT_UNAVAILABLE: { status: 409, message: 'Một số sản phẩm không còn khả dụng.' },
  IDEMPOTENCY_KEY_REUSED: { status: 409, message: 'Yêu cầu đã được gửi với nội dung khác. Vui lòng tải lại giỏ hàng.' },
  RATE_LIMITED: { status: 429, message: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.' },
}
export type CommerceResult = { status: number; body: Record<string, unknown> }
const fail = (code: string, status?: number, extra: Record<string, unknown> = {}): CommerceResult => {
  const known = ERRORS[code]
  return { status: status ?? known?.status ?? 500, body: { ok: false, code, error: known?.message ?? 'Hệ thống đang bận. Vui lòng thử lại sau.', ...extra } }
}

/** Production/Staging gate. Both an explicit flag and the dedicated binding are required; the TEST pilot additionally needs the isolated-database marker. */
export function commerceIntakeEnabled(env: Record<string, unknown> | NodeJS.ProcessEnv = process.env) {
  if (env.PUBLIC_COMMERCE !== 'on') return false
  return env.APP_ENV === 'production' || (env.APP_ENV === 'staging' && env.PREVIEW_TEST_DATABASE_ISOLATED === 'true')
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max: number): string | null => (v === undefined || v === null ? '' : typeof v === 'string' && v.length <= max ? v : null)
function cleanItems(raw: unknown): { productId: number; quantity: number }[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) return null
  const out: { productId: number; quantity: number }[] = []
  for (const item of raw) {
    if (!isObject(item) || !Number.isSafeInteger(item.productId) || (item.productId as number) < 1 || !Number.isSafeInteger(item.quantity) || (item.quantity as number) < 1 || (item.quantity as number) > 99) return null
    out.push({ productId: item.productId as number, quantity: item.quantity as number })   // any price/discount/total sent by the client is dropped here
  }
  return out
}
/** Only whitelisted, type-checked fields reach the database. */
export function parseCommerceBody(kind: CommerceKind, raw: unknown): { ok: true; input: unknown } | { ok: false; code: string } {
  if (!isObject(raw)) return { ok: false, code: 'INVALID_INPUT' }
  const items = cleanItems(raw.items)
  if (kind === 'cart') return items ? { ok: true, input: items } : { ok: false, code: 'INVALID_ITEMS' }
  if (!items) return { ok: false, code: 'INVALID_ITEMS' }
  const fields: Record<string, string> = {}
  for (const [name, max] of [['customerName', 200], ['customerPhone', 40], ['customerEmail', 300], ['deliveryAddress', 600], ['note', 1500]] as const) {
    const value = text(raw[name], max); if (value === null) return { ok: false, code: 'INVALID_INPUT' }
    fields[name] = value
  }
  if (kind === 'quotes') return { ok: true, input: { ...fields, items } }
  if (!Number.isSafeInteger(raw.expectedTotalVnd) || (raw.expectedTotalVnd as number) < 1) return { ok: false, code: 'INVALID_INPUT' }
  return { ok: true, input: { ...fields, items, expectedTotalVnd: raw.expectedTotalVnd } }
}

async function ipHash(request: Request): Promise<string> {
  const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  const day = new Date().toISOString().slice(0, 10)                       // the hash rotates daily; only used for short-lived rate buckets
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`dpg-commerce:${day}:${ip}`))
  return Array.from(new Uint8Array(digest).slice(0, 16), b => b.toString(16).padStart(2, '0')).join('')
}

let pgModule: typeof import('pg') | undefined
async function getBinding(): Promise<CommerceBinding | undefined> {
  const { env } = await import('cloudflare:workers')
  const binding = (env as { ORDER_INTAKE_DB?: CommerceBinding }).ORDER_INTAKE_DB
  return binding?.connectionString ? binding : undefined
}

export async function handleCommerce(kind: CommerceKind, request: Request, deps: { binding?: CommerceBinding; env?: NodeJS.ProcessEnv; connect?: (connectionString: string) => Promise<CommerceClient> } = {}): Promise<CommerceResult> {
  if (!commerceIntakeEnabled(deps.env)) return fail('COMMERCE_DISABLED', 404, { error: 'Not found.' })
  if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405)
  // CSRF-style submissions: a browser always sends Origin on cross-site POSTs; refuse any that is not this deployment, and refuse when neither Origin nor same-origin fetch metadata is present.
  const origin = request.headers.get('origin'), self = new URL(request.url).origin
  if (origin !== null ? origin !== self : request.headers.get('sec-fetch-site') !== 'same-origin') return fail('COMMERCE_ORIGIN_FORBIDDEN', 403, { error: 'Yêu cầu không hợp lệ.' })
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return fail('INVALID_INPUT', 415)
  let key = ''
  if (kind !== 'cart') { key = request.headers.get('idempotency-key') ?? ''; if (!IDEMPOTENCY_KEY.test(key)) return fail('INVALID_IDEMPOTENCY_KEY') }
  const body = await request.text()
  if (new TextEncoder().encode(body).length > COMMERCE_BODY_LIMIT_BYTES) return fail('INVALID_INPUT', 413, { error: 'Dữ liệu quá lớn.' })
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return fail('INVALID_INPUT') }
  const checked = parseCommerceBody(kind, parsed)
  if (!checked.ok) return fail(checked.code)
  const binding = deps.binding ?? await getBinding()
  if (!binding) return fail('COMMERCE_UNAVAILABLE', 503, { error: 'Chức năng đặt hàng tạm thời chưa khả dụng. Vui lòng liên hệ hotline.' })
  const hash = await ipHash(request)

  let client: CommerceClient | undefined, inTransaction = false
  try {
    if (deps.connect) client = await deps.connect(binding.connectionString)
    else {
      const { Client } = pgModule ?? (pgModule = await import('pg'))
      const pg = new Client({ connectionString: binding.connectionString, connectionTimeoutMillis: 3000, query_timeout: 8000 })
      await pg.connect(); client = pg as unknown as CommerceClient
    }
    // The login role cannot INHERIT the intake role (SET only): one transaction, SET LOCAL ROLE, one function call. Business refusals come back as JSON {error} (COMMIT keeps the rate-limit counter).
    await client.query('BEGIN', []); inTransaction = true
    await client.query('SET LOCAL ROLE dpg_commerce_intake', [])
    const response = kind === 'cart'
      ? await client.query(`SELECT ${FUNCTION_OF.cart}($1::jsonb, $2::text) AS result`, [JSON.stringify(checked.input), hash])
      : await client.query(`SELECT ${FUNCTION_OF[kind]}($1::jsonb, $2::text, $3::text) AS result`, [JSON.stringify(checked.input), key, hash])
    await client.query('COMMIT', []); inTransaction = false
    const result = response.rows[0]?.result as Record<string, unknown> | string | undefined
    const value = typeof result === 'string' ? JSON.parse(result) as Record<string, unknown> : result
    if (!value) return fail('COMMERCE_FAILED')
    if (typeof value.error === 'string') {
      const { error } = value
      const money = (v: unknown) => (Number.isSafeInteger(v) ? v : undefined)
      const extra = kind === 'orders' && error === 'PRICE_CHANGED' ? { totalVnd: money(value.totalVnd), subtotalVnd: money(value.subtotalVnd), voucherVnd: money(value.voucherVnd) } : Array.isArray(value.productIds) && value.productIds.every(Number.isSafeInteger) ? { productIds: value.productIds } : {}
      return fail(Object.hasOwn(ERRORS, error) ? error : 'COMMERCE_FAILED', undefined, extra)
    }
    if (value.ok !== true) return fail('COMMERCE_FAILED')
    return { status: kind === 'cart' || value.replayed === true ? 200 : 201, body: value }
  } catch {
    if (inTransaction) await client?.query('ROLLBACK', []).catch(() => undefined)
    return fail('COMMERCE_FAILED')            // never echo database text
  } finally { await client?.end().catch(() => undefined) }
}
