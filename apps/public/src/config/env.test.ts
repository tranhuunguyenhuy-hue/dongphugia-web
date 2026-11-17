import { describe, expect, it } from 'vitest'

import { getPublicAppEnvironment } from './env'

describe('Public application environment contract', () => {
  it('accepts a local build without browser configuration', () => {
    expect(getPublicAppEnvironment({})).toMatchObject({
      application: 'public',
      environment: 'local',
      origin: 'http://localhost:3000',
      previewNoindex: false,
    })
  })

  it('requires noindex and a non-Production origin for Preview', () => {
    expect(() =>
      getPublicAppEnvironment({
        APP_ENV: 'preview',
        APP_ORIGIN: 'http://127.0.0.1:8787',
      }),
    ).toThrow('PUBLIC_PREVIEW_NOINDEX_REQUIRED')

    expect(() =>
      getPublicAppEnvironment({
        APP_ENV: 'preview',
        APP_ORIGIN: 'https://www.dongphugia.vn',
        PREVIEW_NOINDEX: 'true',
      }),
    ).toThrow('PUBLIC_PREVIEW_PRODUCTION_DOMAIN_FORBIDDEN')
  })

  it('accepts the exact Production authority only for Production', () => {
    expect(
      getPublicAppEnvironment({
        APP_ENV: 'production',
        APP_ORIGIN: 'https://www.dongphugia.vn',
      }).origin,
    ).toBe('https://www.dongphugia.vn')

    expect(() =>
      getPublicAppEnvironment({
        APP_ENV: 'production',
        APP_ORIGIN: 'https://public-preview.invalid',
      }),
    ).toThrow('PUBLIC_PRODUCTION_ORIGIN_MISMATCH')
  })

  it('requires noindex and a non-Production origin for Staging', () => {
    expect(() => getPublicAppEnvironment({
      APP_ENV: 'staging',
      APP_ORIGIN: 'https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev',
    })).toThrow('PUBLIC_STAGING_NOINDEX_REQUIRED')

    expect(getPublicAppEnvironment({
      APP_ENV: 'staging',
      APP_ORIGIN: 'https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev',
      PREVIEW_NOINDEX: 'true',
    })).toMatchObject({ environment: 'staging', previewNoindex: true })
  })

  it.each([
    'https://dpg-staging.tranhuunguyenhuy.workers.dev',
    'https://other-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev',
    'https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev:8443',
  ])('rejects an unapproved staging origin %s', (origin) => {
    expect(() => getPublicAppEnvironment({ APP_ENV: 'staging', APP_ORIGIN: origin, PREVIEW_NOINDEX: 'true' }))
      .toThrow('PUBLIC_STAGING_ORIGIN_REQUIRED')
  })

  it('fails closed on privileged or unknown browser environment variables', () => {
    expect(() =>
      getPublicAppEnvironment({
        NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: 'test-only',
      }),
    ).toThrow('PUBLIC_PRIVILEGED_BROWSER_ENV_FORBIDDEN')

    expect(() =>
      getPublicAppEnvironment({
        NEXT_PUBLIC_ADMIN_SESSION: 'test-only',
      }),
    ).toThrow('PUBLIC_BROWSER_ENV_NOT_ALLOWLISTED')

    expect(() =>
      getPublicAppEnvironment({
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-only',
      }),
    ).toThrow('PUBLIC_BROWSER_ENV_NOT_ALLOWLISTED')
  })

  it('tolerates the combined M3 Worker Preview bindings in the shared process environment but still rejects privileged Public names', () => {
    // The combined Worker populates process.env from every Preview binding, including Admin-only secrets.
    const combined = {
      APP_ENV: 'staging',
      APP_ORIGIN: 'https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev',
      PREVIEW_NOINDEX: 'true',
      ADMIN_PREVIEW_MEDIA_KEY: 'synthetic-admin-media-key',
      REVALIDATE_SECRET: 'synthetic-revalidate-secret',
    }
    expect(getPublicAppEnvironment(combined)).toMatchObject({ environment: 'staging', previewNoindex: true })
    // The guard itself is unchanged: the legacy privileged names remain forbidden for Public.
    expect(() => getPublicAppEnvironment({ ...combined, BUNNY_STORAGE_API_KEY: 'x' })).toThrow('PUBLIC_PRIVILEGED_ENV_FORBIDDEN:BUNNY_STORAGE_API_KEY')
  })
})
