import { afterEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '../../proxy'

const origin = 'https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev'
function configure() {
  vi.stubEnv('APP_ENV', 'staging')
  vi.stubEnv('APP_BUILD_TARGET', 'public')
  vi.stubEnv('APP_ORIGIN', origin)
  vi.stubEnv('PREVIEW_NOINDEX', 'true')
  vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', 'snapshot')
  vi.stubEnv('PUBLIC_CATALOGUE_CHECKPOINT', 'c'.repeat(40))
}
afterEach(() => vi.unstubAllEnvs())

it.each(['/blog', '/blog/huong-dan-chon', '/blog/huong-dan-chon/bai-viet'])('allows the pinned M2 snapshot Blog route %s while retaining noindex', path => {
  configure()
  const response = proxy(new NextRequest(origin + path))
  expect(response.status).toBe(200)
  expect(response.headers.get('x-middleware-next')).toBe('1')
  expect(response.headers.get('X-Robots-Tag')).toContain('noindex')
})

it.each(['missing-checkpoint', 'legacy-source', 'preview-fixture'])('still blocks unverified Blog content: %s', mode => {
  configure()
  if (mode === 'missing-checkpoint') vi.stubEnv('PUBLIC_CATALOGUE_CHECKPOINT', '')
  if (mode === 'legacy-source') vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', 'production-published-snapshot')
  if (mode === 'preview-fixture') {
    vi.stubEnv('APP_ENV', 'preview')
    vi.stubEnv('APP_ORIGIN', 'http://localhost:8787')
  }
  const response = proxy(new NextRequest(origin + '/blog'))
  expect(response.status).toBe(503)
  expect(response.headers.get('Cache-Control')).toContain('no-store')
})

it('keeps Production Blog behavior unchanged', () => {
  vi.stubEnv('APP_ENV', 'production')
  vi.stubEnv('APP_BUILD_TARGET', 'public')
  vi.stubEnv('APP_ORIGIN', 'https://www.dongphugia.vn')
  vi.stubEnv('PREVIEW_NOINDEX', 'false')
  const response = proxy(new NextRequest('https://www.dongphugia.vn/blog'))
  expect(response.status).toBe(200)
  expect(response.headers.get('X-Robots-Tag')).toBeNull()
})

it.each(['/blog', '/blog/huong-dan-chon/bai-viet'])('serves Blog from the isolated TEST database on M3 staging %s (noindex kept)', path => {
  vi.stubEnv('APP_ENV', 'staging')
  vi.stubEnv('APP_BUILD_TARGET', 'public')
  vi.stubEnv('APP_ORIGIN', origin)
  vi.stubEnv('PREVIEW_NOINDEX', 'true')
  vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', 'postgresql')
  vi.stubEnv('PREVIEW_TEST_DATABASE_ISOLATED', 'true')
  const response = proxy(new NextRequest(origin + path))
  expect(response.status).toBe(200)
  expect(response.headers.get('X-Robots-Tag')).toContain('noindex')
})

it('keeps blocking staging Blog when the database is not declared isolated', () => {
  vi.stubEnv('APP_ENV', 'staging')
  vi.stubEnv('APP_BUILD_TARGET', 'public')
  vi.stubEnv('APP_ORIGIN', origin)
  vi.stubEnv('PREVIEW_NOINDEX', 'true')
  vi.stubEnv('PUBLIC_CATALOGUE_SOURCE', 'postgresql')
  const response = proxy(new NextRequest(origin + '/blog'))
  expect(response.status).toBe(503)
})
