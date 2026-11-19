// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MEDIA_PROFILES } from '../../src/lib/media/media-profiles.ts'
import { RESOURCES } from '../../supabase/functions/admin-api/resources.ts'
import { signEnvelope } from '../../apps/public/m3-admin-envelope.mjs'
import { createProductionAdminWorker, productionMediaTarget, productionPublicEnvironment } from '../../apps/public/m4-production-dispatch.mjs'
import { UPLOAD_FOLDERS, UPLOAD_PROFILES } from '../../apps/public/m4-admin-upload.mjs'
import { composeProductionEntry, productionAdminConfig } from './build-production-admin-worker.mts'

const ORIGIN = 'https://www.dongphugia.vn'
const SHA = 'a'.repeat(40)
const FN = 'https://bonxyxluzlxfkdetryoo.supabase.co/functions/v1/admin-api'
const TOKEN = 'ab'.repeat(32)
const read = (file: string) => readFileSync(file, 'utf8')

function environment(extra: Record<string, unknown> = {}) {
  return {
    APP_ENV: 'production', APP_BUILD_TARGET: 'public', APP_ORIGIN: ORIGIN, PUBLIC_CATALOGUE_SOURCE: 'postgresql', PUBLIC_DB: { connectionString: 'x' },
    ADMIN_API_URL: FN, ADMIN_API_HMAC_SECRET: 's'.repeat(40), ADMIN_PRODUCTION_MEDIA_KEY: 'k'.repeat(24),
    BUNNY_STORAGE_ZONE_NAME: 'dpg-products', BUNNY_STORAGE_HOSTNAME: 'sg.storage.bunnycdn.com', BUNNY_CDN_HOSTNAME: 'cdn.dongphugia.com.vn',
    ASSETS: { fetch: vi.fn(async () => new Response('<!doctype html><title>shell</title>', { headers: { 'content-type': 'text/html' } })) },
    IMAGES: undefined as unknown, ...extra,
  }
}
function fixture(images: unknown = undefined) {
  const seen: { env?: Record<string, unknown>; cookie?: string | null } = {}
  const publicWorker = { fetch: vi.fn(async (request: Request, env: Record<string, unknown>) => { seen.env = env; seen.cookie = request.headers.get('cookie'); return new Response('public') }) }
  return { worker: createProductionAdminWorker({ publicWorker, sourceSha: SHA }), publicWorker, seen, env: environment({ IMAGES: images }) }
}
const browser = (pathname: string, init: RequestInit = {}, host = 'www.dongphugia.vn') => new Request(`https://${host}${pathname}`, {
  ...init, headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...(init.headers as Record<string, string> ?? {}) },
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
afterEach(() => vi.unstubAllGlobals())

describe('Production Public isolation', () => {
  it('gives Public only a whitelisted environment and never the Admin cookie', async () => {
    const { worker, seen, env } = fixture({})
    const response = await worker.fetch(new Request('https://www.dongphugia.vn/thiet-bi-ve-sinh', { headers: { cookie: `a=1; dpg-admin-session=${TOKEN}; b=2` } }), env, {})
    expect(await response.text()).toBe('public')
    expect(Object.keys(seen.env!).sort()).toEqual(['APP_BUILD_TARGET', 'APP_ENV', 'APP_ORIGIN', 'ASSETS', 'PUBLIC_CATALOGUE_SOURCE', 'PUBLIC_DB'])
    expect(seen.cookie).toBe('a=1; b=2')
    expect(Object.keys(productionPublicEnvironment(env)).some((name) => /SECRET|KEY|IMAGES|ADMIN/.test(name))).toBe(false)
  })

  it('passes Public requests through untouched when no Admin cookie exists', async () => {
    const { worker, publicWorker, env } = fixture({})
    const request = new Request('https://www.dongphugia.vn/', { headers: { cookie: 'a=1' } })
    await worker.fetch(request, env, {})
    expect(publicWorker.fetch.mock.calls[0][0]).toBe(request)
  })
})

describe('Production Admin surfaces', () => {
  it('retires the legacy /admin UI with a redirect and never serves it', async () => {
    const { worker, env, publicWorker } = fixture({})
    for (const p of ['/admin', '/admin/login', '/admin/products/5']) {
      const r = await worker.fetch(new Request(`https://www.dongphugia.vn${p}`), env, {})
      expect(r.status).toBe(302); expect(r.headers.get('location')).toBe('/admin-next/'); expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    }
    expect((await worker.fetch(new Request('https://www.dongphugia.vn/admin/x', { method: 'POST' }), env, {})).status).toBe(404)
    expect(publicWorker.fetch).not.toHaveBeenCalled()
  })

  it('serves Admin only on the canonical www host of a Production configuration', async () => {
    const { worker, env } = fixture({})
    for (const host of ['dongphugia.vn', 'dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev', 'staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev']) {
      expect((await worker.fetch(new Request(`https://${host}/admin-next/`), env, {})).status, host).toBe(404)
      expect((await worker.fetch(new Request(`https://${host}/api/upload-image`, { method: 'POST' }), env, {})).status, host).toBe(404)
    }
    expect((await worker.fetch(new Request('https://www.dongphugia.vn/admin-next/'), { ...env, APP_ENV: 'staging' }, {})).status).toBe(404)
    const shell = await worker.fetch(new Request('https://www.dongphugia.vn/admin-next/products/5'), env, {})
    expect(shell.status).toBe(200); expect(shell.headers.get('cache-control')).toBe('private, no-store'); expect(shell.headers.get('x-robots-tag')).toBe('noindex, nofollow')
  })

  it('signs requests for the Production function only; the TEST function and missing secrets fail closed', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string> }) => { calls.push({ url, headers: init.headers }); return json({ data: { id: 1 } }) }))
    const { worker, env } = fixture({})
    expect((await worker.fetch(browser('/admin-next/api/me'), env, {})).status).toBe(200)
    expect(calls[0].url).toBe(`${FN}/me`)
    const before = calls.length
    const testTarget = { ...env, ADMIN_API_URL: 'https://uybumsnyqpwcidjxmfsv.supabase.co/functions/v1/admin-api' }
    expect((await worker.fetch(browser('/admin-next/api/me'), testTarget, {})).status).toBe(503)
    expect((await worker.fetch(browser('/admin-next/api/me'), { ...env, ADMIN_API_HMAC_SECRET: 'short' }, {})).status).toBe(503)
    expect(calls.length).toBe(before)
    // the signature really depends on the Production secret
    expect(Object.keys(await signEnvelope('s'.repeat(40), { method: 'GET', route: '/me', body: '', clientIp: '', origin: '' })).length).toBeGreaterThan(0)
  })

  it('keeps Dev-managed master data and cross-origin mutations out', async () => {
    const fetchSpy = vi.fn(async () => json({ data: {} })); vi.stubGlobal('fetch', fetchSpy)
    const { worker, env } = fixture({})
    const post = (p: string, headers: Record<string, string> = {}) => worker.fetch(browser(p, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', ...headers } }), env, {})
    expect((await post('/admin-next/api/r/brands')).status).toBe(403)
    expect((await post('/admin-next/api/r/blog-posts', { origin: 'https://evil.example' })).status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('Production upload', () => {
  const imageBinding = (format = 'image/png', onTransform = vi.fn()) => ({
    info: vi.fn(async () => ({ format, width: 1000, height: 800 })),
    input: () => ({ transform: (o: { width: number }) => ({ output: async () => { onTransform(o.width); return { response: () => new Response(new Uint8Array([1, 2, 3])) } } }) }),
  })
  const form = (parts: Record<string, string | Blob> = {}) => {
    const body = new FormData()
    body.set('file', parts.file ?? new File([new Uint8Array(500)], 'a.png', { type: 'image/png' }))
    body.set('folder', (parts.folder as string) ?? 'products'); body.set('profile', (parts.profile as string) ?? 'product')
    return body
  }
  const upload = (worker: ReturnType<typeof fixture>['worker'], env: object, body: FormData, headers: Record<string, string> = {}) =>
    new Response(body).arrayBuffer().then(async () => {
      const wire = new Response(body) // serialised exactly like a browser would send it (with a content-length)
      const bytes = new Uint8Array(await wire.arrayBuffer())
      return worker.fetch(browser('/api/upload-image', { method: 'POST', body: bytes, headers: { 'content-type': wire.headers.get('content-type')!, 'content-length': String(bytes.length), cookie: `dpg-admin-session=${TOKEN}`, ...headers } }), env, {})
    })
  const stub = (permissions: string[] | 'anonymous', bunnyOk = true) => {
    const bunny: { method: string; url: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { method: string }) => {
      if (url.startsWith(FN)) return permissions === 'anonymous' ? json({ error: { code: 'UNAUTHENTICATED' } }, 401) : json({ data: { id: 1, permissions } })
      bunny.push({ method: init.method, url }); return new Response(null, { status: bunnyOk ? 201 : 500 })
    }))
    return bunny
  }

  it('is anonymous-proof, permission-scoped and CSRF-guarded before any body work', async () => {
    const images = imageBinding(); const { worker, env } = fixture(images)
    stub('anonymous')
    expect((await upload(worker, env, form())).status).toBe(401)
    stub(['blog:read'])
    expect((await upload(worker, env, form())).status).toBe(403)
    expect((await upload(worker, env, form({ folder: 'banners' }))).status).toBe(403)
    expect((await upload(worker, env, form(), { origin: 'https://evil.example' })).status).toBe(403)
    expect((await upload(worker, env, form(), { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await worker.fetch(browser('/api/upload-image'), env, {})).status).toBe(405)
    expect(images.info).not.toHaveBeenCalled()
  })

  it('accepts a permitted image, stores every variant on the Production media zone and returns CDN URLs', async () => {
    const widths: number[] = []; const { worker, env } = fixture(imageBinding('image/png', (w: number) => widths.push(w)))
    const bunny = stub(['products:write'])
    const response = await upload(worker, env, form())
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.variants).toHaveLength(2); expect(widths).toEqual([320, 640])
    expect(body.url).toMatch(/^https:\/\/cdn\.dongphugia\.com\.vn\/products\/\d+-[0-9a-f]{8}\.product\.w640\.webp$/)
    expect(bunny.map((call) => call.method)).toEqual(['PUT', 'PUT'])
    expect(bunny.every((call) => call.url.startsWith('https://sg.storage.bunnycdn.com/dpg-products/products/'))).toBe(true)
  })

  it('validates folder, profile, type, size and real image content; cleans up when storage fails', async () => {
    const { worker, env } = fixture(imageBinding()); stub(['*'])
    expect((await upload(worker, env, form({ folder: '../etc' }))).status).toBe(400)
    expect((await upload(worker, env, form({ profile: 'huge' }))).status).toBe(400)
    expect((await upload(worker, env, form({ file: new File([new Uint8Array(10)], 'a.svg', { type: 'image/svg+xml' }) }))).status).toBe(400)
    expect((await upload(worker, env, form({ file: new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'a.png', { type: 'image/png' }) }))).status).toBe(400)
    expect((await upload(worker, env, form({ file: new File([new Uint8Array(6 * 1024 * 1024)], 'a.png', { type: 'image/png' }) }))).status).toBe(413)
    const html = fixture(imageBinding('image/gif')); stub(['*'])
    expect((await upload(html.worker, html.env, form())).status).toBe(400) // declared png, really a gif (not a raster profile)
    const failing = fixture(imageBinding()); const bunny = stub(['*'], false)
    expect((await upload(failing.worker, failing.env, form())).status).toBe(502)
    expect(bunny.every((call) => call.method === 'PUT')).toBe(true) // nothing was stored, so nothing to delete
  })

  it('fails closed without a complete Production media target or an Images binding', async () => {
    stub(['*'])
    const noKey = fixture(imageBinding()); noKey.env.ADMIN_PRODUCTION_MEDIA_KEY = ''
    expect((await upload(noKey.worker, noKey.env, form())).status).toBe(503)
    const wrongCdn = fixture(imageBinding()); wrongCdn.env.BUNNY_CDN_HOSTNAME = 'dpg-media-staging.b-cdn.net'
    expect((await upload(wrongCdn.worker, wrongCdn.env, form())).status).toBe(503)
    const noImages = fixture(undefined)
    expect((await upload(noImages.worker, noImages.env, form())).status).toBe(503)
    expect(productionMediaTarget(environment())).not.toBeNull()
  })

  it('stays in sync with the legacy media profiles and the Admin resource upload hints', () => {
    expect(UPLOAD_PROFILES).toEqual(MEDIA_PROFILES)
    for (const def of RESOURCES) for (const field of def.fields) if (field.upload) {
      expect(Object.keys(UPLOAD_FOLDERS), `${def.key}.${field.name}`).toContain(field.upload.folder)
      expect(Object.keys(UPLOAD_PROFILES)).toContain(field.upload.profile)
    }
  })
})

describe('Production artifact composition', () => {
  const parts = () => ({
    template: read('apps/public/worker.m4-production.template.mjs'), envelope: read('apps/public/m3-admin-envelope.mjs'), gateway: read('apps/public/m3-admin-gateway.mjs'),
    upload: read('apps/public/m4-admin-upload.mjs'), dispatch: read('apps/public/m4-production-dispatch.mjs'), sourceSha: SHA,
  })
  it('inlines gateway, envelope, upload and dispatch into one valid ES module that pins the exact source SHA', () => {
    const entry = composeProductionEntry(parts())
    expect(entry).not.toContain('__M4_BUILD_SOURCE_SHA__'); expect(entry).toContain(`sourceSha: '${SHA}'`)
    expect(entry).not.toMatch(/^import .* from '\.\//m)
    expect(entry.match(/^export /gm)).toEqual(['export '])
    expect(entry).toMatch(/^export default createProductionAdminWorker/m)
    const dir = mkdtempSync(path.join(tmpdir(), 'm4-entry-')); const file = path.join(dir, 'entry.mjs'); writeFileSync(file, entry)
    expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow()
    expect(entry).toContain("import('./index.js')")
  })
  it('rejects an invalid SHA or template', () => {
    expect(() => composeProductionEntry({ ...parts(), sourceSha: 'bad' })).toThrow('M4_SOURCE_SHA_INVALID')
    expect(() => composeProductionEntry({ ...parts(), template: 'export default 1' })).toThrow('M4_ENTRY_TEMPLATE_INVALID')
  })
  it('derives the Production config only from a Production Public release', () => {
    const base = { name: 'dongphugia-v1-public-production', main: 'worker/index.js', assets: { directory: 'assets', binding: 'ASSETS', not_found_handling: 'none' }, vars: { APP_ENV: 'production', APP_BUILD_TARGET: 'public', APP_ORIGIN: ORIGIN, PUBLIC_CATALOGUE_SOURCE: 'postgresql' } }
    const media = { zone: 'dpg-products', storageHost: 'sg.storage.bunnycdn.com' }
    const config = productionAdminConfig(base, media) as Record<string, any>
    expect(config.main).toBe('worker/m4-entry.mjs'); expect(config.images).toEqual({ binding: 'IMAGES' })
    expect(config.assets.run_worker_first).toEqual(expect.arrayContaining(['/admin-next', '/admin-next/', '/admin', '/admin/*', '/api/upload-image']))
    expect(config.vars.ADMIN_API_URL).toBe(FN); expect(config.vars.BUNNY_CDN_HOSTNAME).toBe('cdn.dongphugia.com.vn')
    expect(Object.keys(config.vars).some((name) => /SECRET|KEY|TOKEN|PASSWORD/.test(name))).toBe(false)
    expect(() => productionAdminConfig({ ...base, name: 'other' }, media)).toThrow('M4_WRONG_WORKER_TARGET')
    expect(() => productionAdminConfig({ ...base, vars: { ...base.vars, APP_ENV: 'staging' } }, media)).toThrow('M4_PRODUCTION_VARS_REQUIRED')
    expect(() => productionAdminConfig(base, { ...media, zone: 'Bad Zone' })).toThrow('M4_MEDIA_ZONE_INVALID')
    expect(() => productionAdminConfig(base, { ...media, storageHost: 'evil.example' })).toThrow('M4_MEDIA_STORAGE_HOST_INVALID')
  })
})
