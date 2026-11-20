import { expect, it } from 'vitest'
import { createCombinedM3Worker } from './m3-combined-dispatch.mjs'

const STAGING_ORIGIN = 'https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev'

function fixture() {
  const calls = { public: [], admin: [], assets: [] }
  const assets = {
    async fetch(request) {
      calls.assets.push({ path: new URL(request.url).pathname, cookie: request.headers.get('cookie') })
      if (new URL(request.url).pathname === '/admin/_next/static/admin.js') {
        return new Response('admin asset', { headers: { 'Content-Type': 'text/javascript' } })
      }
      if (new URL(request.url).pathname === '/_next/static/public.js') {
        return new Response('public asset', { headers: { 'Content-Type': 'text/javascript' } })
      }
      return new Response('not found', { status: 404 })
    },
  }
  const publicWorker = {
    async fetch(request, environment) {
      calls.public.push({
        path: new URL(request.url).pathname,
        cookie: request.headers.get('cookie'),
        authorization: request.headers.get('authorization'),
        environmentKeys: Object.keys(environment),
        publicDb: environment.PUBLIC_DB,
      })
      return new Response('public')
    },
  }
  const adminWorker = {
    async fetch(request, environment) {
      calls.admin.push({
        path: new URL(request.url).pathname,
        cookie: request.headers.get('cookie'),
        hyperdrive: environment.HYPERDRIVE_ADMIN_NO_CACHE,
        role: environment.RUNTIME_ROLE,
        appEnv: environment.APP_ENV,
        testRole: environment.ADMIN_TEST_DB_ROLE,
        mediaKey: environment.BUNNY_STORAGE_API_KEY,
        revalidateSecret: environment.REVALIDATE_SECRET,
        images: environment.IMAGES,
      })
      return new Response('admin', { headers: { 'Set-Cookie': 'dpg-admin-session=test; Path=/; HttpOnly; Secure' } })
    },
  }
  return {
    calls,
    worker: createCombinedM3Worker({ publicWorker, adminWorker }),
    environment: {
      APP_ENV: 'staging',
      APP_ORIGIN: STAGING_ORIGIN,
      APP_BUILD_TARGET: 'public',
      PREVIEW_NOINDEX: 'true',
      BUILD_SOURCE_SHA: 'a'.repeat(40),
      PUBLIC_CATALOGUE_SOURCE: 'postgresql',
      ADMIN_TEST_DB_ROLE: 'dpg_admin_m3_test',
      PREVIEW_TEST_DATABASE_ISOLATED: 'true',
      PUBLIC_DB: { connectionString: 'public-test-readonly' },
      HYPERDRIVE_ADMIN_NO_CACHE: { connectionString: 'synthetic-test-admin' },
      ADMIN_PREVIEW_MEDIA_KEY: 'synthetic-preview-media-key',
      REVALIDATE_SECRET: 'synthetic-preview-revalidate-secret',
      IMAGES: { synthetic: 'images-binding' },
      ASSETS: assets,
    },
  }
}

it('routes Admin only to the isolated runtime and removes its session, database, and media credentials from Public', async () => {
  const { worker, environment, calls } = fixture()
  const context = { waitUntil() {} }
  const adminResponse = await worker.fetch(new Request(`${STAGING_ORIGIN}/api/upload-image`, {
    method: 'POST', headers: { cookie: 'dpg-admin-session=private-token' },
  }), environment, context)
  const publicResponse = await worker.fetch(new Request(`${STAGING_ORIGIN}/`, {
    headers: {
      cookie: 'dpg-admin-session=private-token; CF_Authorization=access-jwt; theme=light',
      authorization: 'Bearer public-request-token',
    },
  }), environment, context)

  expect(adminResponse.status).toBe(200)
  expect(adminResponse.headers.get('cache-control')).toBe('private, no-store')
  expect(adminResponse.headers.get('x-robots-tag')).toBe('noindex, nofollow')
  expect(adminResponse.headers.get('set-cookie')).toContain('Path=/')
  expect(publicResponse.status).toBe(200)
  expect(calls.admin).toEqual([{
    path: '/api/upload-image',
    cookie: 'dpg-admin-session=private-token',
    hyperdrive: environment.HYPERDRIVE_ADMIN_NO_CACHE,
    role: 'staging',
    appEnv: 'preview',
    testRole: 'dpg_admin_m3_test',
    mediaKey: 'synthetic-preview-media-key',
    revalidateSecret: 'synthetic-preview-revalidate-secret',
    images: environment.IMAGES,
  }])
  expect(calls.public).toHaveLength(1)
  expect(calls.public[0].cookie).toBe('theme=light')
  expect(calls.public[0].authorization).toBe('Bearer public-request-token')
  expect(calls.public[0].publicDb).toBe(environment.PUBLIC_DB)
  expect(calls.public[0].environmentKeys).toContain('PREVIEW_TEST_DATABASE_ISOLATED')
  expect(calls.public[0].environmentKeys).not.toContain('HYPERDRIVE_ADMIN_NO_CACHE')
  expect(calls.public[0].environmentKeys).not.toContain('ADMIN_TEST_DB_ROLE')
  expect(calls.public[0].environmentKeys).not.toContain('BUNNY_STORAGE_API_KEY')
  expect(calls.public[0].environmentKeys).not.toContain('ADMIN_PREVIEW_MEDIA_KEY')
  expect(calls.public[0].environmentKeys).not.toContain('RUNTIME_ROLE')
  expect(calls.public[0].environmentKeys).not.toContain('WRITE_FREEZE_MODE')
  expect(calls.public[0].environmentKeys).not.toContain('REVALIDATE_SECRET')
  expect(calls.public[0].environmentKeys).not.toContain('IMAGES')
})

it('routes only the Admin image upload API to the Admin runtime', async () => {
  const { worker, environment, calls } = fixture()
  const context = { waitUntil() {} }
  const response = await worker.fetch(new Request(`${STAGING_ORIGIN}/api/upload-image`, { method: 'POST' }), environment, context)

  expect(response.status).toBe(200)
  expect(calls.admin.map(({ path }) => path)).toEqual(['/api/upload-image'])
  expect(calls.public).toHaveLength(0)
})

it('routes the legacy Admin revalidation endpoint to the Admin-only Preview secret scope', async () => {
  const { worker, environment, calls } = fixture()
  const context = { waitUntil() {} }
  const response = await worker.fetch(new Request(`${STAGING_ORIGIN}/api/admin/revalidate`, { method: 'POST' }), environment, context)

  expect(response.status).toBe(200)
  expect(calls.admin.map(({ path, revalidateSecret }) => ({ path, revalidateSecret }))).toEqual([{
    path: '/api/admin/revalidate',
    revalidateSecret: 'synthetic-preview-revalidate-secret',
  }])
  expect(calls.public).toHaveLength(0)
})

it('serves Public framework asset paths without forwarding cookies or authorization', async () => {
  const { worker, environment, calls } = fixture()
  const context = { waitUntil() {} }
  const publicAsset = await worker.fetch(new Request(`${STAGING_ORIGIN}/_next/static/public.js`), environment, context)

  expect(await publicAsset.text()).toBe('public asset')
  expect(calls.assets).toEqual([
    { path: '/_next/static/public.js', cookie: null },
  ])
  expect(calls.admin).toHaveLength(0)
  expect(calls.public).toHaveLength(0)
})

it('fails closed for a missing Admin database, wrong TEST identity, or non-staging host', async () => {
  const { worker, environment, calls } = fixture()
  const context = { waitUntil() {} }
  const noDatabase = await worker.fetch(new Request(`${STAGING_ORIGIN}/api/upload-image`, { method: 'POST' }), {
    ...environment,
    HYPERDRIVE_ADMIN_NO_CACHE: undefined,
  }, context)
  const wrongRole = await worker.fetch(new Request(`${STAGING_ORIGIN}/api/upload-image`, { method: 'POST' }), {
    ...environment,
    ADMIN_TEST_DB_ROLE: 'dpg_runtime',
  }, context)
  const productionHost = await worker.fetch(new Request('https://www.dongphugia.vn/api/upload-image', { method: 'POST' }), environment, context)

  expect(noDatabase.status).toBe(503)
  expect(wrongRole.status).toBe(503)
  expect(productionHost.status).toBe(404)
  expect(calls.admin).toHaveLength(0)
  expect(calls.public).toHaveLength(0)
})

it('keeps Admin process.env writes out of Public requests, including concurrent ones, and restores nothing globally', async () => {
  const seen = []
  const adminWorker = {
    async fetch() {
      process.env.APP_ENV = 'preview'
      process.env.APP_BUILD_TARGET = 'admin'
      await new Promise((resolve) => setTimeout(resolve, 30))
      seen.push({ side: 'admin', appEnv: process.env.APP_ENV, keys: Object.keys(process.env).includes('APP_BUILD_TARGET') })
      return new Response('admin')
    },
  }
  const publicWorker = {
    async fetch() {
      seen.push({ side: 'public', appEnv: process.env.APP_ENV, target: process.env.APP_BUILD_TARGET ?? null })
      return new Response('public')
    },
  }
  const { environment } = fixture()
  const worker = createCombinedM3Worker({ publicWorker, adminWorker })
  process.env.APP_ENV = 'staging'
  const context = { waitUntil() {} }

  const admin = worker.fetch(new Request(`${STAGING_ORIGIN}/api/upload-image`, { method: 'POST' }), environment, context)
  await new Promise((resolve) => setTimeout(resolve, 5))
  await worker.fetch(new Request(`${STAGING_ORIGIN}/`), environment, context) // overlaps the in-flight Admin request
  await admin
  await worker.fetch(new Request(`${STAGING_ORIGIN}/`), environment, context)

  expect(seen.filter(({ side }) => side === 'public')).toEqual([
    { side: 'public', appEnv: 'staging', target: null },
    { side: 'public', appEnv: 'staging', target: null },
  ])
  expect(seen.find(({ side }) => side === 'admin')).toEqual({ side: 'admin', appEnv: 'preview', keys: true })
  expect(process.env.APP_ENV).toBe('staging')
  expect(process.env.APP_BUILD_TARGET).toBeUndefined()
})

it('no longer serves the legacy Admin UI on staging: pages redirect to the new Admin, everything else is a 404', async () => {
  const { worker, environment, calls } = fixture()
  const context = { waitUntil() {} }
  for (const path of ['/admin', '/admin/', '/admin/login', '/admin/brands', '/admin/categories/1/edit', '/admin/products']) {
    const page = await worker.fetch(new Request(`${STAGING_ORIGIN}${path}`, { headers: { cookie: 'dpg-admin-session=private-token' } }), environment, context)
    expect(page.status, path).toBe(302)
    expect(page.headers.get('location'), path).toBe('/admin-next/')
    expect(page.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(page.headers.get('cache-control')).toBe('private, no-store')
  }
  for (const [method, path] of [['POST', '/admin/brands'], ['PUT', '/admin/categories/1'], ['DELETE', '/admin/products/1'], ['GET', '/admin/_next/static/admin.js']]) {
    const response = method === 'GET' ? await worker.fetch(new Request(`${STAGING_ORIGIN}${path}`), environment, context) : await worker.fetch(new Request(`${STAGING_ORIGIN}${path}`, { method }), environment, context)
    expect(response.status, `${method} ${path}`).toBe(path.endsWith('.js') ? 302 : 404)
  }
  expect(calls.admin).toHaveLength(0)
  expect(calls.public).toHaveLength(0)
})
