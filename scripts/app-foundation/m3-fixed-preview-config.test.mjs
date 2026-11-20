import { describe, expect, it } from 'vitest'
import {
  createM3FixedPreviewConfig,
  validateM3FixedPreviewConfig,
} from './m3-fixed-preview-config.mjs'

const sourceSha = 'a'.repeat(40)
const publicId = '1'.repeat(32)
const adminId = '2'.repeat(32)
const productionId = '3'.repeat(32)
const mediaTarget = {
  zoneId: 1900001,
  productionZoneId: 1454608,
  storageZoneName: 'dpg-media-staging',
  storageHostname: 'sg.storage.bunnycdn.com',
  cdnHostname: 'dpg-media-staging.b-cdn.net',
}

function create(overrides = {}) {
  return createM3FixedPreviewConfig({
    sourceSha,
    publicHyperdriveId: publicId,
    adminHyperdriveId: adminId,
    productionHyperdriveIds: [productionId],
    productionHyperdriveInventoryVerified: true,
    mediaTarget,
    ...overrides,
  })
}

describe('M3 fixed Preview configuration', () => {
  it('configures two distinct TEST Hyperdrives and Preview-only secrets, vars, and redaction', () => {
    const config = create()

    expect(validateM3FixedPreviewConfig(config, { sourceSha, publicHyperdriveId: publicId, adminHyperdriveId: adminId })).toBe(true)
    expect(config.previews.secrets.required).toEqual(['ADMIN_PREVIEW_MEDIA_KEY', 'REVALIDATE_SECRET', 'ADMIN_API_HMAC_SECRET'])
    expect(config.previews.observability).toMatchObject({
      enabled: true,
      redact_query_string: true,
      logs: { enabled: true, invocation_logs: true, persist: false },
      traces: { enabled: false, persist: false },
    })
    expect(config.previews.images).toEqual({ binding: 'IMAGES' })
    expect(config).not.toHaveProperty('images')
    expect(config.previews.vars).not.toHaveProperty('PUBLIC_CATALOGUE_CHECKPOINT')
    expect(config).not.toHaveProperty('vars')
    expect(config).not.toHaveProperty('hyperdrive')
  })

  it.each([
    ['same Public and Admin Hyperdrive', { adminHyperdriveId: publicId }, 'M3_HYPERDRIVE_BINDINGS_MUST_BE_DISTINCT'],
    ['Production Public Hyperdrive', { publicHyperdriveId: productionId }, 'M3_PUBLIC_HYPERDRIVE_MUST_BE_TEST_ONLY'],
    ['Production Admin Hyperdrive', { adminHyperdriveId: productionId }, 'M3_ADMIN_HYPERDRIVE_MUST_BE_TEST_ONLY'],
    ['unverified Production binding inventory', { productionHyperdriveIds: [], productionHyperdriveInventoryVerified: false }, 'M3_PRODUCTION_HYPERDRIVE_INVENTORY_REQUIRED'],
    ['shared Bunny zone', { mediaTarget: { ...mediaTarget, zoneId: mediaTarget.productionZoneId } }, 'M3_PREVIEW_MEDIA_ZONE_MUST_BE_ISOLATED'],
    ['Production Bunny CDN', { mediaTarget: { ...mediaTarget, cdnHostname: 'cdn.dongphugia.vn' } }, 'M3_PRODUCTION_MEDIA_CDN_FORBIDDEN'],
    ['Production product pull zone host', { mediaTarget: { ...mediaTarget, cdnHostname: 'dpg-products.b-cdn.net' } }, 'M3_PRODUCTION_MEDIA_CDN_FORBIDDEN'],
    ['unapproved CDN host', { mediaTarget: { ...mediaTarget, cdnHostname: 'attacker.example.test' } }, 'M3_PREVIEW_MEDIA_CDN_NOT_APPROVED'],
    ['unapproved storage hostname', { mediaTarget: { ...mediaTarget, storageHostname: 'ny.storage.bunnycdn.com' } }, 'M3_PREVIEW_MEDIA_STORAGE_HOST_NOT_APPROVED'],
    ['Production storage zone name', { mediaTarget: { ...mediaTarget, storageZoneName: 'dpg-products' } }, 'M3_PRODUCTION_MEDIA_ZONE_FORBIDDEN'],
    ['arbitrary storage zone name', { mediaTarget: { ...mediaTarget, storageZoneName: 'other-zone' } }, 'M3_PREVIEW_MEDIA_ZONE_NAME_NOT_APPROVED'],
    ['known Production zone ID reused', { mediaTarget: { ...mediaTarget, zoneId: 1741127 } }, 'M3_PREVIEW_MEDIA_ZONE_MUST_BE_ISOLATED'],
    ['wrong declared Production zone ID', { mediaTarget: { ...mediaTarget, productionZoneId: 402 } }, 'M3_PRODUCTION_MEDIA_ZONE_ID_MISMATCH'],
  ])('rejects %s', (_label, overrides, message) => {
    expect(() => create(overrides)).toThrow(message)
  })
})
