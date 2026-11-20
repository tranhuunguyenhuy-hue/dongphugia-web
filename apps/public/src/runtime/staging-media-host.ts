// Staging-only delivery host for the isolated M3 TEST Bunny zone. It never widens Production:
// every condition below must hold at request time, otherwise no extra host is allowed.
const STAGING_CDN = /^dpg-media-staging(?:-[a-z0-9]+)*\.b-cdn\.net$/
const PRODUCTION_MEDIA_HOSTS = new Set([
  'cdn.dongphugia.com.vn', 'cdn.dongphugia.vn', 'media.dongphugia.vn', 'dpg-products.b-cdn.net',
  'dpg-publishing-production.b-cdn.net', 'dpg-publishing-staging.b-cdn.net',
])

export function stagingMediaHostname(): string | null {
  const environment = process.env
  if (environment.APP_ENV !== 'staging' || environment.PREVIEW_MEDIA_TARGET_ISOLATED !== 'true') return null
  // The Worker only populates process.env from its real bindings, so on the M3 Preview the delivery host is
  // the configured BUNNY_CDN_HOSTNAME variable; PREVIEW_MEDIA_CDN_HOSTNAME stays as an explicit override.
  const host = (environment.PREVIEW_MEDIA_CDN_HOSTNAME ?? environment.BUNNY_CDN_HOSTNAME)?.trim().toLowerCase()
  if (!host || PRODUCTION_MEDIA_HOSTS.has(host) || !STAGING_CDN.test(host)) return null
  return host
}

export function isStagingMediaHost(hostname: string): boolean {
  const allowed = stagingMediaHostname()
  return allowed !== null && hostname.toLowerCase() === allowed
}
