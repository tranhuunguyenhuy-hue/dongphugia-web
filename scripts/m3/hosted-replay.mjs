// Hosted replay / signature / freshness / CSRF-marker check against the TEST `admin-api` function (secret-safe).
// The HMAC secret comes from the environment, is never printed, and every request is signed with the same envelope module the
// gateway uses. Only status codes and error codes are written to the log. TEST project only.
import { signEnvelope, randomNonce } from '../../apps/public/m3-admin-envelope.mjs'

const secret = process.env.M3_ADMIN_API_HMAC_SECRET ?? ''
if (secret.length < 32) { console.error('M3_ADMIN_API_HMAC_SECRET_REQUIRED'); process.exit(1) }
const FUNCTION = 'https://uybumsnyqpwcidjxmfsv.supabase.co/functions/v1/admin-api'
const ORIGIN = 'https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev'
const results = []
const record = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${detail})`) }

async function send(method, route, { body, now, nonce, origin, tamper } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  const headers = await signEnvelope(secret, { method, route, body: payload ?? '', clientIp: '203.0.113.7', origin: origin ?? '', now, nonce })
  if (tamper) headers['x-dpg-sig'] = headers['x-dpg-sig'].replace(/^./, (c) => (c === '0' ? '1' : '0'))
  const response = await fetch(FUNCTION + route, { method, headers: { ...headers, ...(payload ? { 'content-type': 'application/json' } : {}) }, body: payload })
  const json = await response.json().catch(() => ({}))
  return { status: response.status, code: json?.error?.code ?? 'OK' }
}

const nonce = randomNonce(), now = Date.now()
const first = await send('GET', '/me', { nonce, now })
record('valid signature reaches authentication (no session)', first.status === 401 && first.code === 'UNAUTHENTICATED', `${first.status} ${first.code}`)
const replay = await send('GET', '/me', { nonce, now })
record('exact replay of the signed request is rejected', replay.status === 401 && replay.code === 'REPLAYED_REQUEST', `${replay.status} ${replay.code}`)
const again = await send('GET', '/me', { nonce, now })
record('replay stays rejected within the nonce window', again.status === 401 && again.code === 'REPLAYED_REQUEST', `${again.status} ${again.code}`)
const tampered = await send('GET', '/me', { tamper: true })
record('tampered signature is rejected', tampered.status === 401 && tampered.code === 'INVALID_SIGNATURE', `${tampered.status} ${tampered.code}`)
const stale = await send('GET', '/me', { now: Date.now() - 5 * 60_000 })
record('stale timestamp is rejected', stale.status === 401 && stale.code === 'EXPIRED_REQUEST', `${stale.status} ${stale.code}`)
const route = await send('GET', '/schema', { now: Date.now() })
const swapped = await (async () => { const headers = await signEnvelope(secret, { method: 'GET', route: '/schema', body: '', clientIp: '203.0.113.7', origin: '' }); const r = await fetch(FUNCTION + '/orders', { headers }); return { status: r.status, code: (await r.json().catch(() => ({})))?.error?.code } })()
record('signature is bound to the route (signed /schema replayed on /orders)', swapped.status === 401 && swapped.code === 'INVALID_SIGNATURE', `${swapped.status} ${swapped.code}`)
const noMarker = await send('POST', '/logout', { body: {}, now: Date.now() })
record('mutation without the gateway-verified origin marker is refused (CSRF marker)', noMarker.status === 403 && noMarker.code === 'ORIGIN_NOT_ALLOWED', `${noMarker.status} ${noMarker.code}`)
const wrongOrigin = await send('POST', '/logout', { body: {}, origin: 'https://evil.example', now: Date.now() })
record('mutation with a foreign origin marker is refused', wrongOrigin.status === 403 && wrongOrigin.code === 'ORIGIN_NOT_ALLOWED', `${wrongOrigin.status} ${wrongOrigin.code}`)
const okMarker = await send('POST', '/logout', { body: {}, origin: ORIGIN, now: Date.now() })
record('mutation with the approved origin marker passes the CSRF gate', okMarker.status === 200, `${okMarker.status} ${okMarker.code}`)
void route
console.log(results.every(Boolean) ? 'ALL PASS' : 'HAS FAILURES', results.length)
process.exit(results.every(Boolean) ? 0 : 1)
