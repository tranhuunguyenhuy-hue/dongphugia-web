import { AsyncLocalStorage } from 'node:async_hooks'
import { handleAdminNext, isAdminNextPath } from './m3-admin-gateway.mjs' // inline-import

// The Admin handler assigns process.env.APP_ENV='preview', APP_BUILD_TARGET='admin', ... per request. In the combined
// Worker those writes land in the isolate-global process.env and made later Public requests in the same isolate fail
// (Public reads staging config from process.env). Admin requests therefore run in an AsyncLocalStorage overlay:
// writes go to the overlay, reads prefer it, and nothing leaks into Public requests or after the Admin request.
const ADMIN_ENV_SCOPE = new AsyncLocalStorage()
const SCOPED_ENV_MARK = Symbol.for('dpg.m3.scopedProcessEnv')

export function installScopedProcessEnv() {
  if (process.env && process.env[SCOPED_ENV_MARK]) return
  const base = process.env
  const proxy = new Proxy(base, {
    get(target, key, receiver) {
      if (key === SCOPED_ENV_MARK) return true
      const overlay = ADMIN_ENV_SCOPE.getStore()
      return overlay && typeof key === 'string' && Object.hasOwn(overlay, key) ? overlay[key] : Reflect.get(target, key, receiver)
    },
    set(target, key, value) {
      const overlay = ADMIN_ENV_SCOPE.getStore()
      if (overlay && typeof key === 'string') { overlay[key] = String(value); return true }
      return Reflect.set(target, key, value)
    },
    has(target, key) {
      const overlay = ADMIN_ENV_SCOPE.getStore()
      return (overlay && typeof key === 'string' && Object.hasOwn(overlay, key)) || Reflect.has(target, key)
    },
    deleteProperty(target, key) {
      const overlay = ADMIN_ENV_SCOPE.getStore()
      if (overlay && typeof key === 'string') { delete overlay[key]; return true }
      return Reflect.deleteProperty(target, key)
    },
    ownKeys(target) {
      const overlay = ADMIN_ENV_SCOPE.getStore()
      return overlay ? [...new Set([...Reflect.ownKeys(target), ...Object.keys(overlay)])] : Reflect.ownKeys(target)
    },
    getOwnPropertyDescriptor(target, key) {
      const overlay = ADMIN_ENV_SCOPE.getStore()
      if (overlay && typeof key === 'string' && Object.hasOwn(overlay, key)) {
        return { value: overlay[key], writable: true, enumerable: true, configurable: true }
      }
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  process.env = proxy
}

export function runInAdminEnvironmentScope(callback) {
  installScopedProcessEnv()
  return ADMIN_ENV_SCOPE.run(Object.create(null), callback)
}

const ADMIN_BASE_PATH = '/admin'
const ADMIN_SESSION_COOKIE = 'dpg-admin-session'
// Cloudflare Access forwards its own JWT as this cookie; Public pages must never see it (it also made every
// staging request look personalised, so the anonymous page cache could not be exercised).
const PUBLIC_STRIPPED_COOKIES = new Set([ADMIN_SESSION_COOKIE, 'CF_Authorization'])
const FIXED_PREVIEW_HOST = 'staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev'
const STAGING_ORIGIN = `https://${FIXED_PREVIEW_HOST}`
const PUBLIC_HOSTS = new Set([FIXED_PREVIEW_HOST])
const ADMIN_NOINDEX = 'noindex, nofollow'
const PRIVATE_CACHE_CONTROL = 'private, no-store'
const STATIC_PATHS = [
  '/_next/static/',
  '/admin/_next/static/',
  '/_vinext/',
  '/images/',
  '/fonts/',
  '/__catalogue/v1/',
]
const STATIC_FILE = /\.(?:css|js|mjs|map|png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|wasm|json|txt)$/i

function fail(status, message, sourceSha) {
  const headers = new Headers({ 'Cache-Control': PRIVATE_CACHE_CONTROL })
  if (sourceSha) headers.set('X-DPG-Source-SHA', sourceSha)
  return new Response(message, { status, headers })
}

function withHeaders(response, additions) {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(additions)) headers.set(name, value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

function isAdminPath(pathname) {
  return pathname === ADMIN_BASE_PATH
    || pathname.startsWith(`${ADMIN_BASE_PATH}/`)
    || pathname === '/api/admin/revalidate'
    || pathname === '/api/upload-image'
}

/** The retired legacy Admin pages (also its framework assets). `/api/admin/revalidate` and `/api/upload-image` are separate paths. */
function isLegacyAdminUiPath(pathname) {
  return pathname === ADMIN_BASE_PATH || pathname.startsWith(`${ADMIN_BASE_PATH}/`)
}

function isStaticAssetPath(pathname) {
  return STATIC_PATHS.some((prefix) => pathname.startsWith(prefix))
    || pathname === '/favicon.ico'
    || pathname === '/robots.txt'
    || STATIC_FILE.test(pathname)
}

function stripAdminSessionCookie(request) {
  const cookie = request.headers.get('cookie')
  if (!cookie) return request
  const remaining = cookie.split(';').map((part) => part.trim()).filter((part) =>
    part && !PUBLIC_STRIPPED_COOKIES.has(part.split('=', 1)[0]?.trim()),
  )
  const headers = new Headers(request.headers)
  if (remaining.length) headers.set('cookie', remaining.join('; '))
  else headers.delete('cookie')
  return new Request(request, { headers })
}

function assetRequestWithoutCredentials(request) {
  const headers = new Headers(request.headers)
  headers.delete('cookie')
  headers.delete('authorization')
  return new Request(request, { headers })
}

function publicEnvironment(environment) {
  return {
    APP_ENV: environment.APP_ENV,
    APP_BUILD_TARGET: 'public',
    APP_ORIGIN: environment.APP_ORIGIN,
    PREVIEW_NOINDEX: environment.PREVIEW_NOINDEX ?? 'false',
    BUILD_SOURCE_SHA: environment.BUILD_SOURCE_SHA,
    PUBLIC_CATALOGUE_SOURCE: environment.PUBLIC_CATALOGUE_SOURCE,
    PUBLIC_CATALOGUE_CHECKPOINT: environment.PUBLIC_CATALOGUE_CHECKPOINT,
    PUBLIC_DB: environment.PUBLIC_DB,
    // #446: separate, TEST-only order-intake binding (role dpg_order_intake_login). Never the Admin binding, never the read role.
    ORDER_INTAKE_DB: environment.ORDER_INTAKE_DB,
    PUBLIC_COMMERCE: environment.PUBLIC_COMMERCE,
    PREVIEW_TEST_DATABASE_ISOLATED: environment.PREVIEW_TEST_DATABASE_ISOLATED,
    PREVIEW_MEDIA_TARGET_ISOLATED: environment.PREVIEW_MEDIA_TARGET_ISOLATED,
    PREVIEW_MEDIA_CDN_HOSTNAME: environment.BUNNY_CDN_HOSTNAME,
    ASSETS: environment.ASSETS,
  }
}

function adminEnvironment(environment) {
  return {
    APP_ENV: 'preview',
    APP_ORIGIN: STAGING_ORIGIN,
    PREVIEW_NOINDEX: 'true',
    RUNTIME_ROLE: 'staging',
    WRITE_FREEZE_MODE: 'false',
    ALLOW_ISOLATED_TEST_WRITES: 'true',
    ADMIN_TEST_DB_ROLE: environment.ADMIN_TEST_DB_ROLE,
    PREVIEW_MEDIA_TARGET_ISOLATED: environment.PREVIEW_MEDIA_TARGET_ISOLATED,
    BUNNY_STORAGE_ZONE_NAME: environment.BUNNY_STORAGE_ZONE_NAME,
    BUNNY_STORAGE_API_KEY: environment.ADMIN_PREVIEW_MEDIA_KEY,
    BUNNY_STORAGE_HOSTNAME: environment.BUNNY_STORAGE_HOSTNAME,
    BUNNY_CDN_HOSTNAME: environment.BUNNY_CDN_HOSTNAME,
    REVALIDATE_SECRET: environment.REVALIDATE_SECRET,
    IMAGES: environment.IMAGES,
    PRISMA_REQUEST_SCOPE_REQUIRED: 'true',
    HYPERDRIVE_ADMIN_NO_CACHE: environment.HYPERDRIVE_ADMIN_NO_CACHE,
    ASSETS: environment.ASSETS,
  }
}

export function createCombinedM3Worker({ publicWorker, adminWorker }) {
  if (!publicWorker || typeof publicWorker.fetch !== 'function'
    || !adminWorker || typeof adminWorker.fetch !== 'function') {
    throw new Error('COMBINED_WORKER_HANDLERS_REQUIRED')
  }

  installScopedProcessEnv()

  return {
    async fetch(request, environment, context) {
      const { pathname, hostname } = new URL(request.url)
      const sourceSha = typeof environment.BUILD_SOURCE_SHA === 'string' ? environment.BUILD_SOURCE_SHA : undefined
      const adminPath = isAdminPath(pathname)

      const localHost = ['localhost', '127.0.0.1'].includes(hostname)
      if ((!PUBLIC_HOSTS.has(hostname) && !localHost)
        || (!localHost && (environment.APP_ENV !== 'staging' || environment.PREVIEW_NOINDEX !== 'true'))) {
        return fail(404, 'Not found.', sourceSha)
      }
      if (!environment.ASSETS || typeof environment.ASSETS.fetch !== 'function') {
        return fail(503, 'Worker assets binding is unavailable.', sourceSha)
      }

      if (isAdminNextPath(pathname)) return handleAdminNext(request, environment, { sourceSha, stagingOrigin: STAGING_ORIGIN })

      // Owner scope decision (#309): the legacy Next Admin UI (`/admin/*`) is no longer served on staging. Its code and the
      // reviewed artifacts are preserved in the repository, but exposing it would bypass the server-side scope of the new
      // Admin (Dev-managed master data). Pages redirect to the new Admin; everything else under /admin is a 404.
      if (isLegacyAdminUiPath(pathname)) {
        if (request.method === 'GET' || request.method === 'HEAD') {
          return new Response(null, { status: 302, headers: { Location: '/admin-next/', 'Cache-Control': PRIVATE_CACHE_CONTROL, 'X-Robots-Tag': ADMIN_NOINDEX, ...(sourceSha ? { 'X-DPG-Source-SHA': sourceSha } : {}) } })
        }
        return fail(404, 'Not found.', sourceSha)
      }

      if ((request.method === 'GET' || request.method === 'HEAD')
        && isStaticAssetPath(pathname)
        && environment.ASSETS && typeof environment.ASSETS.fetch === 'function') {
        const asset = await environment.ASSETS.fetch(assetRequestWithoutCredentials(request))
        if (asset.status !== 404) {
          return withHeaders(asset, {
            ...(sourceSha ? { 'X-DPG-Source-SHA': sourceSha } : {}),
            ...(adminPath || pathname.startsWith('/admin/_next/') ? { 'X-Robots-Tag': ADMIN_NOINDEX } : {}),
            'Cache-Control': asset.headers.get('Cache-Control') || 'public, max-age=31536000, immutable',
          })
        }
      }

      if (adminPath) {
        if (!environment.HYPERDRIVE_ADMIN_NO_CACHE
          || typeof environment.HYPERDRIVE_ADMIN_NO_CACHE.connectionString !== 'string'
          || !environment.HYPERDRIVE_ADMIN_NO_CACHE.connectionString) {
          return fail(503, 'Admin database binding is unavailable.', sourceSha)
        }
        if (environment.ADMIN_TEST_DB_ROLE !== 'dpg_admin_m3_test') {
          return fail(503, 'Admin TEST database identity is unavailable.', sourceSha)
        }
        const response = await runInAdminEnvironmentScope(() => adminWorker.fetch(request, adminEnvironment(environment), context))
        return withHeaders(response, {
          ...(sourceSha ? { 'X-DPG-Source-SHA': sourceSha } : {}),
          'X-Robots-Tag': ADMIN_NOINDEX,
          'Cache-Control': PRIVATE_CACHE_CONTROL,
        })
      }

      // Public is an anonymous, read-only projection. Never pass the Admin
      // session cookie, database binding, role, or mutation controls to it.
      const publicRequest = stripAdminSessionCookie(request)
      const response = await publicWorker.fetch(publicRequest, publicEnvironment(environment), context)
      return response
    },
  }
}

export { isAdminPath, publicEnvironment, adminEnvironment }
