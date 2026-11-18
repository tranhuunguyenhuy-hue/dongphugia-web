// Local integration stack (not part of the repo): static SPA + real gateway module + Deno function + local PostgreSQL.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { handleAdminNext } from '../../../apps/public/m3-admin-gateway.mjs'

const ORIGIN = 'http://localhost:8800', DIST = new URL('../../../apps/admin-spa/dist', import.meta.url).pathname
const FN = 'https://uybumsnyqpwcidjxmfsv.supabase.co/functions/v1/admin-api'
const realFetch = globalThis.fetch
globalThis.fetch = (url, init) => realFetch(String(url).replace(FN, 'http://127.0.0.1:8799/admin-api'), init)
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const ASSETS = { async fetch(request) {
  let p = new URL(request.url).pathname; if (p.endsWith('/')) p += 'index.html'
  try { return new Response(await readFile(path.join(DIST, p.replace(/^\/admin-next/, ''))), { headers: { 'content-type': TYPES[path.extname(p)] ?? 'application/octet-stream' } }) } catch { return new Response('nf', { status: 404 }) }
} }
const environment = { ADMIN_API_URL: FN, ADMIN_API_HMAC_SECRET: 'local-secret-abcdef-0123456789-long-enough', ASSETS }
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c)
  const request = new Request(ORIGIN + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) })
  let response
  if (req.url === '/api/upload-image') response = new Response(JSON.stringify({ url: 'https://dpg-media-staging.b-cdn.net/products/uploaded-1.webp' }), { headers: { 'content-type': 'application/json' } })
  else if (req.url.startsWith('/admin-next/assets/') || req.url === '/admin-next/') response = await ASSETS.fetch(request)
  else response = await handleAdminNext(request, environment, { sourceSha: 'a'.repeat(40), stagingOrigin: ORIGIN })
  const headers = {}; response.headers.forEach((v, k) => { headers[k] = v }); const cookies = response.headers.getSetCookie?.() ?? []
  if (cookies.length) headers['set-cookie'] = cookies
  res.writeHead(response.status, headers); res.end(Buffer.from(await response.arrayBuffer()))
}).listen(8800, () => console.log('stack on 8800'))
