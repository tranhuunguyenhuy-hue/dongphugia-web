// @vitest-environment node
import { expect, it, vi } from 'vitest'
import {
  classifyM2PublicImageTarget,
  isM2PublicImageTarget,
  legacyBlogImagePostIds,
  legacyBlogImageUrls,
  verifyM2PublicImage,
} from './m2-public-media.mjs'

const origin = 'https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev'
const legacyImage = [...legacyBlogImageUrls].map(raw => new URL(raw)).find(url => url.hostname === 'showroominax.vn' && url.pathname.endsWith('/xu-huong-thiet-bi-ve-sinh-2.png'))!
const accessHeaders = { 'CF-Access-Client-Id': 'private-id', 'CF-Access-Client-Secret': 'private-secret' }

function imageResponse(status: number, headers: Record<string, string> = { 'content-type': 'image/png' }, bytes = Buffer.alloc(32, 1)) {
  return { status: () => status, headers: () => headers, body: async () => bytes }
}

it('classifies only exact reviewed external legacy image URLs as optional and retains their post IDs', () => {
  expect(legacyImage).toBeDefined()
  expect(classifyM2PublicImageTarget(legacyImage, origin)).toBe('optional-legacy')
  expect(legacyBlogImagePostIds.get(legacyImage.href)).toContain(3)
  expect(isM2PublicImageTarget(legacyImage, origin)).toBe(true)
  expect(isM2PublicImageTarget(new URL('https://showroominax.vn/unreviewed-image.jpg'), origin)).toBe(false)
})

it.each([
  'http://media.dongphugia.vn/publishing/image.webp',
  'https://private:secret@media.dongphugia.vn/publishing/image.webp',
  'https://unknown.example/image.jpg',
  'http://127.0.0.1/private',
])('rejects unverified image target %s', raw => {
  expect(classifyM2PublicImageTarget(new URL(raw), origin)).toBe('reject')
  expect(isM2PublicImageTarget(new URL(raw), origin)).toBe(false)
})

it('keeps the existing managed and required media hosts fail-closed', () => {
  for (const host of ['cdn.dongphugia.com.vn', 'dpg-products.b-cdn.net', 'media.dongphugia.vn', 'dpg-publishing-production.b-cdn.net', 'cdn.hita.com.vn', 'hita.com.vn', 'vietceramics.com', 'tygjmrhandbffjllxveu.supabase.co']) {
    expect(classifyM2PublicImageTarget(new URL(`https://${host}/publishing/image.webp`), origin)).toBe('required')
  }
})

it('turns an unavailable exact legacy image into a sanitized warning', async () => {
  const request = { get: vi.fn().mockResolvedValue(imageResponse(503)) }
  const requestForUrl = vi.fn(() => request)
  const result = await verifyM2PublicImage({ url: legacyImage, origin, requestForUrl, headers: accessHeaders, postIds: legacyBlogImagePostIds.get(legacyImage.href) })

  expect(result).toMatchObject({
    status: 'WARN',
    warning: {
      severity: 'WARN',
      kind: 'optional-legacy-third-party-image',
      host: 'showroominax.vn',
      path: legacyImage.pathname,
      postIds: [3],
      httpStatus: 503,
      error: 'http_status',
      timeout: false,
      count: 1,
    },
  })
  expect(JSON.stringify(result)).not.toContain('private-secret')
  expect(request.get).toHaveBeenCalledWith(legacyImage.href, { headers: {}, maxRedirects: 0, timeout: 30000 })
})

it('turns an optional legacy image timeout into a timeout warning', async () => {
  const error = Object.assign(new Error('Timeout 30000ms exceeded'), { name: 'TimeoutError' })
  const request = { get: vi.fn().mockRejectedValue(error) }
  const result = await verifyM2PublicImage({ url: legacyImage, origin, requestForUrl: () => request, postIds: [3] })

  expect(result).toMatchObject({ status: 'WARN', warning: { httpStatus: null, error: 'timeout', timeout: true, postIds: [3] } })
  expect(JSON.stringify(result)).not.toContain('30000ms')
})

it('keeps managed image HTTP failures blocking', async () => {
  const url = new URL('https://media.dongphugia.vn/publishing/essential.webp')
  const request = { get: vi.fn().mockResolvedValue(imageResponse(503)) }

  await expect(verifyM2PublicImage({ url, origin, requestForUrl: () => request })).rejects.toThrow('M2_IMAGE_HTTP_REQUIRED')
})

it('rejects an unreviewed external path before requesting it', async () => {
  const url = new URL('https://showroominax.vn/unreviewed-image.jpg')
  const request = { get: vi.fn() }

  await expect(verifyM2PublicImage({ url, origin, requestForUrl: () => request })).rejects.toThrow('M2_PUBLIC_IMAGE_HOST_REQUIRED')
  expect(request.get).not.toHaveBeenCalled()
})

it('keeps unsafe or credentialed redirects blocking and never forwards Access headers externally', async () => {
  const unsafeRequest = { get: vi.fn().mockResolvedValue(imageResponse(302, { location: 'https://private:secret@showroominax.vn/private.jpg' })) }
  await expect(verifyM2PublicImage({ url: legacyImage, origin, requestForUrl: () => unsafeRequest, headers: accessHeaders })).rejects.toThrow('M2_IMAGE_REDIRECT_UNSAFE')
  expect(unsafeRequest.get).toHaveBeenCalledTimes(1)
  expect(unsafeRequest.get).toHaveBeenCalledWith(legacyImage.href, { headers: {}, maxRedirects: 0, timeout: 30000 })

  const internalRequest = { get: vi.fn().mockResolvedValue(imageResponse(302, { location: legacyImage.href })) }
  const externalRequest = { get: vi.fn().mockResolvedValue(imageResponse(200)) }
  const requestForUrl = (url: URL) => url.origin === origin ? internalRequest : externalRequest
  const localImage = new URL('/images/logo-icon.svg', origin)
  const result = await verifyM2PublicImage({ url: localImage, origin, requestForUrl, headers: accessHeaders })

  expect(result.status).toBe('PASS')
  expect(internalRequest.get).toHaveBeenCalledWith(localImage.href, { headers: accessHeaders, maxRedirects: 0, timeout: 30000 })
  expect(externalRequest.get).toHaveBeenCalledWith(legacyImage.href, { headers: {}, maxRedirects: 0, timeout: 30000 })
})

it('rejects a redirect to an unreviewed path on an otherwise allowlisted third-party host', async () => {
  const request = { get: vi.fn().mockResolvedValue(imageResponse(302, { location: 'https://showroominax.vn/unreviewed-image.jpg' })) }

  await expect(verifyM2PublicImage({ url: legacyImage, origin, requestForUrl: () => request })).rejects.toThrow('M2_IMAGE_REDIRECT_UNSAFE')
  expect(request.get).toHaveBeenCalledTimes(1)
})
