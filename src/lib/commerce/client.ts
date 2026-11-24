// #470 commerce v1 browser client: thin fetch helpers for /api/commerce/*. No price is ever sent; the order call echoes only the total the customer SAW.
import type { CartLine } from './cart-store'

export type CheckedLine =
    | { productId: number; quantity: number; mode: 'unavailable' }
    | { productId: number; sku: string; name: string; brand: string | null; quantity: number; mode: 'quote'; reason: string }
    | { productId: number; sku: string; name: string; brand: string | null; quantity: number; mode: 'order'; regularVnd: number; unitSellingVnd: number; unitVoucherVnd: number; lineTotalVnd: number }
export type CartCheck = {
    lines: CheckedLine[]
    order: { count: number; subtotalVnd: number; voucherVnd: number; totalVnd: number }
    quoteCount: number
    unavailableCount: number
}
export type Contact = { customerName: string; customerPhone: string; customerEmail: string; deliveryAddress: string; note: string }
export type Receipt = { kind: 'order' | 'quote'; code: string; status: string; totalVnd?: number; subtotalVnd?: number; voucherVnd?: number; lineCount: number; at: number }
export type ApiFailure = { ok: false; http: number; code: string; error: string; totalVnd?: number; subtotalVnd?: number; voucherVnd?: number; productIds?: number[] }
export type ApiResult<T> = ({ ok: true; http: number } & T) | ApiFailure

const items = (lines: Pick<CartLine, 'productId' | 'quantity'>[]) => lines.map(({ productId, quantity }) => ({ productId, quantity }))

async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<ApiResult<T>> {
    try {
        const response = await fetch(`/api/commerce/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), cache: 'no-store' })
        const json = await response.json().catch(() => null) as Record<string, unknown> | null
        if (response.ok && json?.ok === true) return { ...(json as T), ok: true, http: response.status }
        return { ...(json ?? {}), ok: false, http: response.status, code: typeof json?.code === 'string' ? json.code : 'COMMERCE_FAILED',
            error: typeof json?.error === 'string' ? json.error : 'Hệ thống đang bận. Vui lòng thử lại sau.' } as ApiFailure
    } catch {
        return { ok: false, http: 0, code: 'NETWORK', error: 'Không kết nối được máy chủ. Vui lòng kiểm tra mạng và thử lại.' }
    }
}

export const checkCart = (lines: Pick<CartLine, 'productId' | 'quantity'>[]) => post<CartCheck>('cart', { items: items(lines) })
export const submitOrder = (contact: Contact, lines: Pick<CartLine, 'productId' | 'quantity'>[], expectedTotalVnd: number, idempotencyKey: string) =>
    post<Omit<Receipt, 'at'> & { replayed?: boolean }>('orders', { ...contact, items: items(lines), expectedTotalVnd }, { 'idempotency-key': idempotencyKey })
export const submitQuote = (contact: Contact, lines: Pick<CartLine, 'productId' | 'quantity'>[], idempotencyKey: string) =>
    post<Omit<Receipt, 'at'> & { replayed?: boolean }>('quotes', { ...contact, items: items(lines) }, { 'idempotency-key': idempotencyKey })

/** The same attempt (same payload) keeps the same key across network failures and reloads, so a retry replays the SAME receipt instead of creating a second one. */
export async function attemptKey(kind: 'order' | 'quote', payload: unknown): Promise<{ storageKey: string; key: string }> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)))
    const storageKey = `dpg-attempt-v2:${kind}:${Array.from(new Uint8Array(digest).slice(0, 16), b => b.toString(16).padStart(2, '0')).join('')}`
    let key: string | null = null
    try { key = sessionStorage.getItem(storageKey) } catch { /* private mode: a fresh key per click is still safe (server-side idempotency needs the same key only for retries) */ }
    if (!key) { key = `${kind}-${crypto.randomUUID()}`; try { sessionStorage.setItem(storageKey, key) } catch { /* ignore */ } }
    return { storageKey, key }
}
export const forgetAttempt = (storageKey: string) => { try { sessionStorage.removeItem(storageKey) } catch { /* ignore */ } }

const RECEIPTS_KEY = 'dpg-receipts-v2'
export function saveReceipt(receipt: Receipt) {
    try { const list = JSON.parse(sessionStorage.getItem(RECEIPTS_KEY) ?? '[]') as Receipt[]; sessionStorage.setItem(RECEIPTS_KEY, JSON.stringify([...list.filter(item => item.code !== receipt.code), receipt].slice(-10))) } catch { /* ignore */ }
}
export function loadReceipts(): Receipt[] {
    try {
        const list = JSON.parse(sessionStorage.getItem(RECEIPTS_KEY) ?? '[]') as unknown
        return Array.isArray(list) ? list.filter((item): item is Receipt => typeof item?.code === 'string' && /^(DH|BG)-[0-9A-F]{10}$/.test(item.code)) : []
    } catch { return [] }
}
