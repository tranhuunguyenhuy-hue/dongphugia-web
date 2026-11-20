import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const hosts = new Set(['cdn.dongphugia.com.vn','dpg-products.b-cdn.net','media.dongphugia.vn','dpg-publishing-production.b-cdn.net','cdn.hita.com.vn','hita.com.vn','vietceramics.com','tygjmrhandbffjllxveu.supabase.co'])
const archive = JSON.parse(readFileSync(new URL('../../apps/public/src/runtime/legacy-blog-snapshot.json', import.meta.url), 'utf8'))
assert.equal(archive.contract, 'dpg:verified-legacy-blog-snapshot:v1')
// Preserve the exact original image references already reviewed in M1, without
// granting arbitrary paths on every third-party host mentioned in an article.
export const legacyBlogImageUrls = new Set()
export const legacyBlogImagePostIds = new Map()
for (const post of archive.posts) {
  const references = [
    post.thumbnail_url, post.cover_image_url,
    ...[...post.content.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(match => match[1]),
  ]
  for (const raw of references) {
    try {
      const url = new URL(raw?.replaceAll('&amp;', '&'))
      if (url.protocol !== 'https:' || url.username || url.password) continue
      legacyBlogImageUrls.add(url.href)
      const postIds = legacyBlogImagePostIds.get(url.href) ?? []
      if (Number.isSafeInteger(post.id) && !postIds.includes(post.id)) postIds.push(post.id)
      legacyBlogImagePostIds.set(url.href, postIds)
    } catch {}
  }
}

export function classifyM2PublicImageTarget(url, origin) {
  if (url.username || url.password) return 'reject'
  if (url.origin === origin) return 'required'
  if (url.protocol !== 'https:') return 'reject'
  if (hosts.has(url.hostname)) return 'required'
  if (legacyBlogImageUrls.has(url.href)) return 'optional-legacy'
  return 'reject'
}

export function isM2PublicImageTarget(url, origin) {
  return classifyM2PublicImageTarget(url, origin) !== 'reject'
}

function optionalImageWarning(url, postIds, httpStatus, error, timeout = false) {
  return {
    severity: 'WARN',
    kind: 'optional-legacy-third-party-image',
    host: url.hostname,
    path: url.pathname,
    postIds: [...new Set(postIds.filter(Number.isSafeInteger))],
    httpStatus,
    error,
    timeout,
    count: 1,
    impact: 'This legacy third-party image may not display; the page and catalogue routes remain available.',
  }
}

function imageRequestFailure(error) {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /timeout|timed out/i.test(message)
    ? { error: 'timeout', timeout: true }
    : { error: 'request_failed', timeout: false }
}

export async function verifyM2PublicImage({ url: target, origin, requestForUrl, headers = {}, postIds = [] }) {
  let url = new URL(target.href)
  let optional = classifyM2PublicImageTarget(url, origin) === 'optional-legacy'

  for (let hop = 0; hop < 4; hop++) {
    const classification = classifyM2PublicImageTarget(url, origin)
    if (classification === 'reject') throw new Error('M2_PUBLIC_IMAGE_HOST_REQUIRED')
    if (classification === 'required') optional = false
    if (url.username || url.password) throw new Error('M2_PUBLIC_IMAGE_CREDENTIALS_FORBIDDEN')

    let response
    try {
      response = await requestForUrl(url).get(url.href, {
        headers: url.origin === origin ? headers : {},
        maxRedirects: 0,
        timeout: 30000,
      })
    } catch (error) {
      if (!optional) throw new Error('M2_IMAGE_FETCH_REQUIRED')
      const failure = imageRequestFailure(error)
      return { status: 'WARN', warning: optionalImageWarning(url, postIds, null, failure.error, failure.timeout) }
    }

    if ([301, 302, 303, 307, 308].includes(response.status())) {
      const location = response.headers().location
      if (!location) throw new Error('M2_IMAGE_REDIRECT_LOCATION_REQUIRED')
      const nextUrl = new URL(location, url)
      if (classifyM2PublicImageTarget(nextUrl, origin) === 'reject' || nextUrl.username || nextUrl.password) {
        throw new Error('M2_IMAGE_REDIRECT_UNSAFE')
      }
      if (hop === 3) throw new Error('M2_IMAGE_REDIRECT_LIMIT')
      url = nextUrl
      continue
    }

    if (response.status() !== 200) {
      if (!optional) throw new Error('M2_IMAGE_HTTP_REQUIRED')
      return { status: 'WARN', warning: optionalImageWarning(url, postIds, response.status(), 'http_status') }
    }

    let bytes
    try {
      bytes = await response.body()
    } catch (error) {
      if (!optional) throw new Error('M2_IMAGE_BYTES_REQUIRED')
      const failure = imageRequestFailure(error)
      return { status: 'WARN', warning: optionalImageWarning(url, postIds, 200, failure.error, failure.timeout) }
    }
    const mime = response.headers()['content-type'] || ''
    if (!/^image\//.test(mime) || bytes.length <= 16) {
      if (!optional) throw new Error('M2_IMAGE_CONTENT_REQUIRED')
      return { status: 'WARN', warning: optionalImageWarning(url, postIds, 200, 'invalid_image_response') }
    }
    return { status: 'PASS', image: { host: url.hostname, path: url.pathname, bytes: bytes.length, mime: mime.split(';')[0] } }
  }

  throw new Error('M2_IMAGE_REDIRECT_LIMIT')
}
