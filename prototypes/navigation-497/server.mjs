import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { canonicalProduct, publicOrigin, searchSample } from './catalogue.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoAssets = resolve(here, '../../public/images')
const assets = process.env.NAV_ASSETS || repoAssets
const port = Number(process.env.PORT || 4970)
const host = process.env.HOST || '127.0.0.1'
const liveSearch = process.argv.includes('--live-search')
const snapshot = JSON.parse(await readFile(resolve(here, 'snapshot.json'), 'utf8'))
const routes = new Set(['/', '/danh-muc', '/gio-hang', '/tim-kiem'])
const files = new Map(Object.entries({
  '/style.css': 'text/css; charset=utf-8',
  '/app.mjs': 'text/javascript; charset=utf-8',
  '/catalogue.mjs': 'text/javascript; charset=utf-8',
  '/icons.mjs': 'text/javascript; charset=utf-8',
  '/presentation.mjs': 'text/javascript; charset=utf-8',
  '/snapshot.json': 'application/json',
}))
const assetFiles = new Map(Object.entries({
  'Logo.png': ['Logo.png', 'image/png'],
  'interior.jpg': ['about-bathroom.jpg', 'image/png'],
  'inax.png': ['brands/inax.png', 'image/png'],
  'toto.png': ['brands/toto.png', 'image/png'],
  'karofi.png': ['brands/karofi.png', 'image/png'],
  'elica.png': ['brands/elica.png', 'image/png'],
}))

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

function productFields({ id, sku, name, url }) {
  return { id, sku, name, url }
}

async function search(url, response) {
  const q = (url.searchParams.get('q') ?? '').trim()
  const limit = Number(url.searchParams.get('limit') ?? 8)
  if (q.length > 120 || !Number.isInteger(limit) || limit < 1 || limit > 48) {
    return json(response, 400, { error: 'Truy vấn không hợp lệ.' })
  }
  const source = liveSearch ? 'live' : 'snapshot'
  if (q.length < 2) return json(response, 200, { results: [], source })
  try {
    if (!liveSearch) {
      return json(response, 200, { results: searchSample(snapshot.products, q, limit).map(productFields), source })
    }
    const query = new URLSearchParams({ q, limit: String(limit) })
    const upstream = await fetch(`${publicOrigin}/api/search?${query}`, {
      redirect: 'error', signal: AbortSignal.timeout(5500), headers: { Accept: 'application/json' },
    })
    if (!upstream.ok) throw new Error('Search failed')
    const data = await upstream.json()
    const results = data.results.filter(product => canonicalProduct.test(product.url) &&
      typeof product.name === 'string' && typeof product.sku === 'string').map(productFields)
    json(response, 200, { results, source })
  } catch {
    json(response, 503, { error: 'Tìm kiếm tạm thời gián đoạn.', source })
  }
}

createServer(async (request, response) => {
  response.setHeader('X-Robots-Tag', 'noindex, nofollow')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'")
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed' })
  try {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/api/search') return await search(url, response)
    const asset = assetFiles.get(url.pathname.slice('/assets/'.length))
    const path = url.pathname
    let file
    let contentType
    if (routes.has(path)) {
      file = resolve(here, 'index.html')
      contentType = 'text/html; charset=utf-8'
    } else if (files.has(path)) {
      file = resolve(here, path.slice(1))
      contentType = files.get(path)
    } else if (path.startsWith('/assets/') && asset) {
      file = resolve(assets, asset[0])
      contentType = asset[1]
    } else {
      return json(response, 404, { error: 'Not found' })
    }
    const bytes = await readFile(file)
    response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': bytes.length })
    response.end(request.method === 'HEAD' ? undefined : bytes)
  } catch {
    json(response, 500, { error: 'Prototype asset unavailable' })
  }
}).listen(port, host, () => console.log(`Navigation #497 · http://${host}:${port} · ${liveSearch ? 'public search API' : 'local search snapshot'}`))
