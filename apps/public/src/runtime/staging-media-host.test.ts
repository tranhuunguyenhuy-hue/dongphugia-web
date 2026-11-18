import { afterEach, describe, expect, it } from 'vitest'
import { isStagingMediaHost, stagingMediaHostname } from './staging-media-host'

const original = { ...process.env }
function env(values: Record<string, string | undefined>) {
  for (const key of ['APP_ENV', 'PREVIEW_MEDIA_TARGET_ISOLATED', 'PREVIEW_MEDIA_CDN_HOSTNAME', 'BUNNY_CDN_HOSTNAME']) delete process.env[key]
  Object.assign(process.env, values)
}
afterEach(() => { process.env = { ...original } })

describe('staging-only media delivery host', () => {
  const staging = { APP_ENV: 'staging', PREVIEW_MEDIA_TARGET_ISOLATED: 'true', PREVIEW_MEDIA_CDN_HOSTNAME: 'dpg-media-staging.b-cdn.net' }

  it('allows only the exact isolated staging CDN host on the staging Preview', () => {
    env(staging)
    expect(stagingMediaHostname()).toBe('dpg-media-staging.b-cdn.net')
    expect(isStagingMediaHost('dpg-media-staging.b-cdn.net')).toBe(true)
    expect(isStagingMediaHost('dpg-products.b-cdn.net')).toBe(false)
    expect(isStagingMediaHost('evil.example.test')).toBe(false)
  })

  it.each([
    ['Production environment', { ...staging, APP_ENV: 'production' }],
    ['unflagged media target', { ...staging, PREVIEW_MEDIA_TARGET_ISOLATED: 'false' }],
    ['Production CDN host', { ...staging, PREVIEW_MEDIA_CDN_HOSTNAME: 'dpg-products.b-cdn.net' }],
    ['arbitrary host', { ...staging, PREVIEW_MEDIA_CDN_HOSTNAME: 'attacker.example.test' }],
    ['missing host', { ...staging, PREVIEW_MEDIA_CDN_HOSTNAME: undefined }],
  ])('adds no host for %s', (_label, values) => {
    env(values)
    expect(stagingMediaHostname()).toBeNull()
    expect(isStagingMediaHost('dpg-media-staging.b-cdn.net')).toBe(false)
  })

  it('uses the configured BUNNY_CDN_HOSTNAME variable the Worker actually exposes, still only when isolated staging', () => {
    env({ APP_ENV: 'staging', PREVIEW_MEDIA_TARGET_ISOLATED: 'true', BUNNY_CDN_HOSTNAME: 'dpg-media-staging.b-cdn.net' })
    expect(stagingMediaHostname()).toBe('dpg-media-staging.b-cdn.net')
    env({ APP_ENV: 'production', PREVIEW_MEDIA_TARGET_ISOLATED: 'true', BUNNY_CDN_HOSTNAME: 'dpg-media-staging.b-cdn.net' })
    expect(stagingMediaHostname()).toBeNull()
    env({ APP_ENV: 'staging', PREVIEW_MEDIA_TARGET_ISOLATED: 'true', BUNNY_CDN_HOSTNAME: 'dpg-products.b-cdn.net' })
    expect(stagingMediaHostname()).toBeNull()
  })
})
