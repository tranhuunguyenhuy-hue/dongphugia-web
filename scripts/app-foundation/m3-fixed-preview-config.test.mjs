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
  zoneId: 401,
  productionZoneId: 402,
  storageZoneName: 'dpg-m3-preview-media',
  storageHostname: 'sg.storage.bunnycdn.com',
  cdnHostname: 'm3-preview-media.example.test',
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
    expect(config.previews.secrets.required).toEqual(['BUNNY_STORAGE_API_KEY', 'REVALIDATE_SECRET'])
    expect(config.previews.observability).toMatchObject({
      enabled: true,
      redact_query_string: true,
      logs: { enabled: true, invocation_logs: true, persist: false },
      traces: { enabled: false, persist: false },
    })
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
  ])('rejects %s', (_label, overrides, message) => {
    expect(() => create(overrides)).toThrow(message)
  })
})
