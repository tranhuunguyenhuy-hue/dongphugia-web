// #446: guest order intake for the isolated TEST Preview ONLY. The Public read role never writes; orders go through the
// dedicated `ORDER_INTAKE_DB` Hyperdrive (role dpg_order_intake_login, EXECUTE on public.guest_order_request_create only).
// Prices, vouchers and totals are re-derived inside the database function from the three canonical columns; nothing a
// client sends about prices is read here, and the voucher is deducted exactly once (per unit x quantity, order level).
export type OrderIntakeBinding = { connectionString: string }
export type IntakeClient = { query: (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; end: () => Promise<unknown> }

export const ORDER_BODY_LIMIT_BYTES = 16_384
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,200}$/
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Business errors raised or returned by the database function, mapped to a stable HTTP status + Vietnamese message.
const ERRORS: Record<string, { status: number; message: string }> = {
  INVALID_INPUT: { status: 400, message: 'Dữ liệu đặt hàng không hợp lệ.' },
  INVALID_IDEMPOTENCY_KEY: { status: 400, message: 'Yêu cầu không hợp lệ. Vui lòng thử lại.' },
  INVALID_CUSTOMER_NAME: { status: 400, message: 'Vui lòng nhập họ tên hợp lệ.' },
  INVALID_CUSTOMER_PHONE: { status: 400, message: 'Vui lòng nhập số điện thoại Việt Nam hợp lệ.' },
  INVALID_CUSTOMER_EMAIL: { status: 400, message: 'Email không hợp lệ.' },
  INVALID_CUSTOMER_ADDRESS: { status: 400, message: 'Địa chỉ không hợp lệ.' },
  INVALID_NOTE: { status: 400, message: 'Ghi chú quá dài.' },
  INVALID_ITEM: { status: 400, message: 'Sản phẩm trong giỏ hàng không hợp lệ.' },
  INVALID_QUANTITY: { status: 400, message: 'Số lượng không hợp lệ.' },
  INVALID_INSTALL_OPTION: { status: 400, message: 'Tùy chọn lắp đặt không hợp lệ.' },
  DUPLICATE_PRODUCT: { status: 400, message: 'Mỗi sản phẩm chỉ được xuất hiện một lần trong đơn hàng.' },
  PRODUCT_UNAVAILABLE: { status: 409, message: 'Một hoặc nhiều sản phẩm không còn khả dụng để đặt hàng.' },
  PRODUCT_REQUIRES_QUOTE: { status: 422, message: 'Sản phẩm chưa có giá hợp lệ. Vui lòng yêu cầu báo giá.' },
  IDEMPOTENCY_KEY_REUSED: { status: 409, message: 'Yêu cầu đã được gửi với nội dung khác. Vui lòng tải lại giỏ hàng.' },
  ORDER_RATE_LIMITED: { status: 429, message: 'Quá nhiều yêu cầu, vui lòng thử lại sau.' },
}
export type OrderIntakeResult =
  | { ok: true; status: 200; body: { success: true; order_number: string; order_status: string; payment_status: string } }
  | { ok: false; status: number; body: { success: false; error: string; code: string } }

const fail = (code: string, status?: number, message?: string): OrderIntakeResult => {
  const known = ERRORS[code]
  return { ok: false, status: status ?? known?.status ?? 500, body: { success: false, error: message ?? known?.message ?? 'Lỗi server. Vui lòng thử lại.', code } }
}

/** Only the isolated TEST Preview may take orders; Production builds have no binding and stay closed. */
export function orderIntakeEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.APP_ENV === 'staging' && env.PREVIEW_TEST_DATABASE_ISOLATED === 'true'
}

export function parseOrderRequest(raw: unknown): { ok: true; input: Record<string, unknown> } | { ok: false; code: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'INVALID_INPUT' }
  const body = raw as Record<string, unknown>
  const items = body.items
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) return { ok: false, code: 'INVALID_INPUT' }
  const cleanItems: Record<string, unknown>[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, code: 'INVALID_ITEM' }
    const { productId, sku, quantity, installOption } = item as Record<string, unknown>
    if (!Number.isSafeInteger(productId) || (productId as number) < 1) return { ok: false, code: 'INVALID_ITEM' }
    if (typeof sku !== 'string' || sku.trim() === '' || sku.length > 100) return { ok: false, code: 'INVALID_ITEM' }
    if (!Number.isSafeInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 99) return { ok: false, code: 'INVALID_QUANTITY' }
    if (installOption !== undefined && !['none', 'install', 'replace'].includes(String(installOption))) return { ok: false, code: 'INVALID_INSTALL_OPTION' }
    // Prices/vouchers/totals from the client are intentionally dropped: the database derives them.
    cleanItems.push({ productId, sku, quantity, ...(installOption === undefined ? {} : { installOption }) })
  }
  const text = (value: unknown) => (typeof value === 'string' ? value : value === undefined || value === null ? '' : null)
  const fields: Record<string, string> = {}
  for (const name of ['customer_name', 'customer_phone', 'customer_email', 'customer_address', 'note']) {
    const value = text(body[name])
    if (value === null) return { ok: false, code: 'INVALID_INPUT' }
    fields[name] = value
  }
  return { ok: true, input: { ...fields, items: cleanItems } }
}

let pgModule: typeof import('pg') | undefined
async function getBinding(): Promise<OrderIntakeBinding | undefined> {
  const { env } = await import('cloudflare:workers')
  const binding = (env as { ORDER_INTAKE_DB?: OrderIntakeBinding }).ORDER_INTAKE_DB
  return binding?.connectionString ? binding : undefined
}

export async function createGuestOrder(
  request: Request,
  deps: { binding?: OrderIntakeBinding; env?: NodeJS.ProcessEnv; connect?: (connectionString: string) => Promise<IntakeClient> } = {},
): Promise<OrderIntakeResult> {
  if (!orderIntakeEnabled(deps.env)) return fail('ORDER_INTAKE_DISABLED', 404, 'Not found.')
  // Browsers always send Origin on cross-site POSTs: refuse any that is not this deployment (CSRF-style submissions).
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== new URL(request.url).origin) return fail('ORDER_ORIGIN_FORBIDDEN', 403, 'Yêu cầu không hợp lệ.')
  const idempotencyKey = request.headers.get('idempotency-key') ?? ''
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) return fail('INVALID_IDEMPOTENCY_KEY')
  const requestId = request.headers.get('x-request-id')
  const text = await request.text()
  if (new TextEncoder().encode(text).length > ORDER_BODY_LIMIT_BYTES) return fail('INVALID_INPUT', 413, 'Dữ liệu đặt hàng quá lớn.')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return fail('INVALID_INPUT') }
  const checked = parseOrderRequest(parsed)
  if (!checked.ok) return fail(checked.code)
  const binding = deps.binding ?? await getBinding()
  if (!binding) return fail('ORDER_INTAKE_UNAVAILABLE', 503, 'Chức năng đặt hàng tạm thời chưa khả dụng.')

  let client: IntakeClient | undefined
  let inTransaction = false
  try {
    if (deps.connect) client = await deps.connect(binding.connectionString)
    else {
      const { Client } = pgModule ?? (pgModule = await import('pg'))
      const pg = new Client({ connectionString: binding.connectionString, connectionTimeoutMillis: 3000, query_timeout: 8000 })
      await pg.connect()
      client = pg as unknown as IntakeClient
    }
    // The login role does not INHERIT the intake role (rolinherit=false, SET only): the RPC EXECUTE privilege belongs to
    // `dpg_order_intake`, so the call runs in one transaction under SET LOCAL ROLE. Known business failures come back as
    // {error} (COMMIT keeps the rate-limit counter); raised errors ROLLBACK.
    await client!.query('BEGIN', [])
    inTransaction = true
    await client!.query('SET LOCAL ROLE dpg_order_intake', [])
    const response = await client!.query(
      'SELECT public.guest_order_request_create($1::jsonb, $2::text, $3::uuid) AS result',
      [JSON.stringify(checked.input), idempotencyKey, requestId && REQUEST_ID.test(requestId) ? requestId : null],
    )
    await client!.query('COMMIT', [])
    inTransaction = false
    const result = response.rows[0]?.result as Record<string, unknown> | undefined
    if (result && typeof result.error === 'string') return fail(Object.hasOwn(ERRORS, result.error) ? result.error : 'ORDER_REQUEST_FAILED')
    if (!result || typeof result.order_number !== 'string') return fail('ORDER_REQUEST_FAILED')
    return { ok: true, status: 200, body: { success: true, order_number: result.order_number, order_status: String(result.status), payment_status: String(result.payment_status) } }
  } catch (error) {
    if (inTransaction) await client?.query('ROLLBACK', []).catch(() => undefined)
    const message = error instanceof Error ? error.message : ''
    return fail(Object.hasOwn(ERRORS, message) ? message : 'ORDER_REQUEST_FAILED')
  } finally {
    await client?.end().catch(() => undefined)
  }
}
