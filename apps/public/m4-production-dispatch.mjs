// Production entry (M4): wraps the unchanged canonical Public Worker and adds ONLY the new Admin surfaces on www.
//   /admin-next/*        static SPA shell + same-origin gateway to the Production Edge Function (HMAC envelope)
//   /api/upload-image    dedicated Worker-native upload (m4-admin-upload.mjs), session validated through the function
//   /admin, /admin/*     retired legacy Admin UI -> 302 /admin-next/ (other methods 404); never rendered
// Public requests receive a WHITELISTED environment (no Admin secret/binding ever reaches the Public guard, which rejects
// secret-looking names) and never see the Admin session cookie. Source is concatenated by the builder (inline-import).
import { handleAdminNext, isAdminNextPath } from './m3-admin-gateway.mjs' // inline-import
import { handleAdminUpload, UPLOAD_PATH } from './m4-admin-upload.mjs' // inline-import

export const PRODUCTION_ORIGIN = 'https://www.dongphugia.vn'
const ADMIN_HOST = 'www.dongphugia.vn'
const PRODUCTION_FUNCTION_URL = /^https:\/\/bonxyxluzlxfkdetryoo\.supabase\.co\/functions\/v1\/admin-api$/
const PRODUCTION_MEDIA_CDN_HOST = 'cdn.dongphugia.com.vn'
const ADMIN_BASE_PATH = '/admin'
const PRODUCTION_SESSION_COOKIE = 'dpg-admin-session'
const PUBLIC_ENV_KEYS = ['APP_ENV', 'APP_BUILD_TARGET', 'APP_ORIGIN', 'PUBLIC_CATALOGUE_SOURCE', 'PUBLIC_DB', 'PUBLIC_DB_DIAGNOSTICS', 'ASSETS']

const isLegacyAdminUiPath = (pathname) => pathname === ADMIN_BASE_PATH || pathname.startsWith(`${ADMIN_BASE_PATH}/`)

export function productionPublicEnvironment(environment) {
  const result = {}
  for (const key of PUBLIC_ENV_KEYS) if (key in environment) result[key] = environment[key]
  return result
}

export function stripAdminSessionCookie(request) {
  const cookie = request.headers.get('cookie')
  if (!cookie) return request
  const remaining = cookie.split(';').map((part) => part.trim()).filter((part) => part && part.split('=', 1)[0]?.trim() !== PRODUCTION_SESSION_COOKIE)
  if (remaining.length === cookie.split(';').map((part) => part.trim()).filter(Boolean).length) return request
  const headers = new Headers(request.headers)
  if (remaining.length) headers.set('cookie', remaining.join('; ')); else headers.delete('cookie')
  return new Request(request, { headers })
}

/** Exact Production media target or null (the upload handler then fails closed with 503). */
export function productionMediaTarget(environment) {
  const apiKey = environment.ADMIN_PRODUCTION_MEDIA_KEY
  if (typeof apiKey !== 'string' || apiKey.length < 16) return null
  const storageZone = environment.BUNNY_STORAGE_ZONE_NAME, storageHost = environment.BUNNY_STORAGE_HOSTNAME
  if (typeof storageZone !== 'string' || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(storageZone)) return null
  if (typeof storageHost !== 'string' || !/^(?:[a-z]{2,3}\.)?storage\.bunnycdn\.com$/.test(storageHost)) return null
  if (environment.BUNNY_CDN_HOSTNAME !== PRODUCTION_MEDIA_CDN_HOST) return null
  return { storageZone, apiKey, storageHost, cdnHost: PRODUCTION_MEDIA_CDN_HOST }
}

const noindexHeaders = (sourceSha) => ({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', ...(sourceSha ? { 'X-DPG-Source-SHA': sourceSha } : {}) })

export function createProductionAdminWorker({ publicWorker, sourceSha }) {
  if (!publicWorker || typeof publicWorker.fetch !== 'function') throw new Error('PRODUCTION_WORKER_PUBLIC_HANDLER_REQUIRED')
  const adminContext = { sourceSha, stagingOrigin: PRODUCTION_ORIGIN, approvedFunctionUrl: PRODUCTION_FUNCTION_URL }
  return {
    async fetch(request, environment, context) {
      const url = new URL(request.url)
      const adminSurface = isAdminNextPath(url.pathname) || isLegacyAdminUiPath(url.pathname) || url.pathname === UPLOAD_PATH
      if (!adminSurface) return publicWorker.fetch(stripAdminSessionCookie(request), productionPublicEnvironment(environment), context)

      // Admin surfaces exist only on the canonical host of the Production deployment; the apex (redirected by Public),
      // workers.dev and every other host never serve them.
      const localHost = ['localhost', '127.0.0.1'].includes(url.hostname)
      if ((url.hostname !== ADMIN_HOST && !localHost) || environment.APP_ENV !== 'production' || environment.APP_ORIGIN !== PRODUCTION_ORIGIN) {
        return new Response('Not found.', { status: 404, headers: noindexHeaders(sourceSha) })
      }
      if (isLegacyAdminUiPath(url.pathname)) {
        if (request.method === 'GET' || request.method === 'HEAD') return new Response(null, { status: 302, headers: { Location: '/admin-next/', ...noindexHeaders(sourceSha) } })
        return new Response('Not found.', { status: 404, headers: noindexHeaders(sourceSha) })
      }
      if (url.pathname === UPLOAD_PATH) {
        return handleAdminUpload(request, {
          media: productionMediaTarget(environment), images: environment.IMAGES, origin: PRODUCTION_ORIGIN, sourceSha,
          // Same signed `/me` call the SPA uses: validates the HttpOnly session cookie against the Production function.
          authorize: async (original) => {
            const probe = new Request(`${PRODUCTION_ORIGIN}/admin-next/api/me`, { method: 'GET', headers: { cookie: original.headers.get('cookie') ?? '', 'cf-connecting-ip': original.headers.get('cf-connecting-ip') ?? '' } })
            const response = await handleAdminNext(probe, environment, adminContext)
            if (response.status !== 200) return { status: response.status, permissions: [] }
            const payload = await response.json().catch(() => null)
            return { status: 200, permissions: Array.isArray(payload?.data?.permissions) ? payload.data.permissions : [] }
          },
        })
      }
      if (!environment.ASSETS || typeof environment.ASSETS.fetch !== 'function') return new Response('Worker assets binding is unavailable.', { status: 503, headers: noindexHeaders(sourceSha) })
      return handleAdminNext(request, environment, adminContext)
    },
  }
}
