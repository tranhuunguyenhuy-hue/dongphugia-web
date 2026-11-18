// Signed Worker -> admin-api request envelope. Pure Web Crypto so the same module runs in the Cloudflare
// Worker gateway, the Supabase Edge runtime (Deno) and Node tests. No secrets are logged or returned.
const encoder = new TextEncoder()
export const ENVELOPE_VERSION = 'v1'
export const MAX_SKEW_SECONDS = 60
export const NONCE_TTL_SECONDS = 120

const toHex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function sha256Hex(value) {
  return toHex(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value))
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
}

export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Everything the function acts on is covered by the signature: route, body, client ip, verified origin, session. */
export async function canonicalString({ timestamp, nonce, method, route, body, clientIp, origin, sessionToken }) {
  const bodyHash = await sha256Hex(body ?? '')
  const sessionHash = sessionToken ? await sha256Hex(sessionToken) : ''
  return [ENVELOPE_VERSION, timestamp, nonce, method.toUpperCase(), route, bodyHash, clientIp ?? '', origin ?? '', sessionHash].join('\n')
}

export function randomNonce() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}

/** Canonical route = path after the function prefix + normalized query. Both sides MUST derive it from a parsed URL. */
export function routeOf(urlString) {
  const url = new URL(urlString)
  const index = url.pathname.indexOf('/admin-api')
  const path = (index >= 0 ? url.pathname.slice(index + '/admin-api'.length) : url.pathname) || '/'
  return path + url.search
}

/** Gateway side: returns the headers to send. `route` is the path+search AFTER the function prefix. */
export async function signEnvelope(secret, { method, route, body, clientIp, origin, sessionToken, now = Date.now(), nonce = randomNonce() }) {
  const timestamp = String(Math.floor(now / 1000))
  const signature = await hmacHex(secret, await canonicalString({ timestamp, nonce, method, route, body, clientIp, origin, sessionToken }))
  const headers = {
    'x-dpg-ts': timestamp, 'x-dpg-nonce': nonce, 'x-dpg-sig': signature,
    'x-dpg-ip': clientIp ?? '', 'x-dpg-origin': origin ?? '',
  }
  if (sessionToken) headers['x-dpg-session'] = sessionToken
  return headers
}

/** Function side: pure signature + freshness check. Replay (nonce reuse) is enforced atomically by the caller in the DB. */
export async function verifyEnvelope(secret, { method, route, body, headers, now = Date.now() }) {
  const get = (name) => headers.get(name) ?? ''
  const timestamp = get('x-dpg-ts'), nonce = get('x-dpg-nonce'), signature = get('x-dpg-sig')
  if (!secret || !/^\d{10}$/.test(timestamp) || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(signature)) return { ok: false, code: 'INVALID_SIGNATURE' }
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > MAX_SKEW_SECONDS) return { ok: false, code: 'EXPIRED_REQUEST' }
  const expected = await hmacHex(secret, await canonicalString({
    timestamp, nonce, method, route, body, clientIp: get('x-dpg-ip'), origin: get('x-dpg-origin'), sessionToken: get('x-dpg-session'),
  }))
  if (!timingSafeEqualHex(expected, signature)) return { ok: false, code: 'INVALID_SIGNATURE' }
  return { ok: true, nonce, clientIp: get('x-dpg-ip'), origin: get('x-dpg-origin'), sessionToken: get('x-dpg-session') }
}
