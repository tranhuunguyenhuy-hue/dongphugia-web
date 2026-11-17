import assert from 'node:assert/strict'
import {
  FIXED_PREVIEW_NAME,
  FIXED_PREVIEW_ORIGIN,
  FIXED_PREVIEW_WORKER,
} from '../../apps/public/src/config/fixed-preview.mjs'

const SOURCE_SHA = /^[a-f0-9]{40}$/
const HYPERDRIVE_ID = /^[a-f0-9]{32}$/i
// The Admin media key uses a non-`BUNNY_*` binding name: the combined Worker's process.env is populated from
// every binding, and the shared Public guard rejects a `BUNNY_STORAGE_API_KEY` there at module init (CF 10021).
const PREVIEW_SECRETS = ['ADMIN_PREVIEW_MEDIA_KEY', 'REVALIDATE_SECRET']
const PRODUCTION_MEDIA_HOSTS = new Set([
  'cdn.dongphugia.com.vn', 'cdn.dongphugia.vn', 'media.dongphugia.vn', 'dpg-products.b-cdn.net',
  'dpg-publishing-production.b-cdn.net', 'dpg-publishing-staging.b-cdn.net', 'sg.storage.bunnycdn.com.production',
])
// Approved isolated Preview media target (Owner-created, Standard tier, 1 region, no replication).
const APPROVED_PREVIEW_ZONE_NAME = 'dpg-media-staging'
const APPROVED_STORAGE_HOSTNAME = 'sg.storage.bunnycdn.com'
const APPROVED_PREVIEW_CDN = /^dpg-media-staging(?:-[a-z0-9]+)*\.b-cdn\.net$/
// Known Production Bunny Storage Zone IDs/names (historical verified inventory). Storage Zone IDs only: never Pull Zone IDs.
const PRODUCTION_STORAGE_ZONE_IDS = new Set(['1454608', '1741127', '1741228'])
const LEGACY_PRODUCTION_MEDIA_ZONE_ID = '1454608'
const PRODUCTION_STORAGE_ZONE_NAMES = new Set(['dpg-products', 'dpg-publishing-production', 'dpg-publishing-staging', 'production-r2'])

function assertHostname(value, code) {
  assert.equal(typeof value, 'string', code)
  assert.match(value, /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, code)
  return value.toLowerCase()
}

export function createM3FixedPreviewConfig({
  sourceSha,
  publicHyperdriveId,
  adminHyperdriveId,
  productionHyperdriveIds = [],
  productionHyperdriveInventoryVerified = false,
  mediaTarget,
}) {
  assert.match(sourceSha || '', SOURCE_SHA, 'M3_SOURCE_SHA_REQUIRED')
  assert.match(publicHyperdriveId || '', HYPERDRIVE_ID, 'M3_PUBLIC_TEST_HYPERDRIVE_REQUIRED')
  assert.match(adminHyperdriveId || '', HYPERDRIVE_ID, 'M3_ADMIN_TEST_HYPERDRIVE_REQUIRED')
  assert.notEqual(publicHyperdriveId.toLowerCase(), adminHyperdriveId.toLowerCase(), 'M3_HYPERDRIVE_BINDINGS_MUST_BE_DISTINCT')
  assert.ok(Array.isArray(productionHyperdriveIds), 'M3_PRODUCTION_HYPERDRIVE_INVENTORY_REQUIRED')
  assert.equal(productionHyperdriveInventoryVerified, true, 'M3_PRODUCTION_HYPERDRIVE_INVENTORY_REQUIRED')
  for (const id of productionHyperdriveIds) {
    assert.match(id || '', HYPERDRIVE_ID, 'M3_PRODUCTION_HYPERDRIVE_INVENTORY_INVALID')
  }
  const productionIds = new Set(productionHyperdriveIds.map((id) => id.toLowerCase()))
  assert.ok(!productionIds.has(publicHyperdriveId.toLowerCase()), 'M3_PUBLIC_HYPERDRIVE_MUST_BE_TEST_ONLY')
  assert.ok(!productionIds.has(adminHyperdriveId.toLowerCase()), 'M3_ADMIN_HYPERDRIVE_MUST_BE_TEST_ONLY')

  assert.ok(mediaTarget && typeof mediaTarget === 'object', 'M3_PREVIEW_MEDIA_TARGET_REQUIRED')
  assert.match(String(mediaTarget.zoneId ?? ''), /^[1-9][0-9]*$/, 'M3_PREVIEW_MEDIA_ZONE_ID_REQUIRED')
  assert.match(String(mediaTarget.productionZoneId ?? ''), /^[1-9][0-9]*$/, 'M3_PRODUCTION_MEDIA_ZONE_ID_REQUIRED')
  assert.notEqual(String(mediaTarget.zoneId), String(mediaTarget.productionZoneId), 'M3_PREVIEW_MEDIA_ZONE_MUST_BE_ISOLATED')
  assert.equal(String(mediaTarget.productionZoneId), LEGACY_PRODUCTION_MEDIA_ZONE_ID, 'M3_PRODUCTION_MEDIA_ZONE_ID_MISMATCH')
  assert.ok(!PRODUCTION_STORAGE_ZONE_IDS.has(String(mediaTarget.zoneId)), 'M3_PREVIEW_MEDIA_ZONE_MUST_BE_ISOLATED')
  assert.ok(typeof mediaTarget.storageZoneName === 'string' && mediaTarget.storageZoneName.length > 0, 'M3_PREVIEW_MEDIA_ZONE_NAME_REQUIRED')
  assert.ok(!PRODUCTION_STORAGE_ZONE_NAMES.has(mediaTarget.storageZoneName), 'M3_PRODUCTION_MEDIA_ZONE_FORBIDDEN')
  assert.equal(mediaTarget.storageZoneName, APPROVED_PREVIEW_ZONE_NAME, 'M3_PREVIEW_MEDIA_ZONE_NAME_NOT_APPROVED')
  const storageHostname = assertHostname(mediaTarget.storageHostname, 'M3_PREVIEW_MEDIA_STORAGE_HOST_REQUIRED')
  assert.equal(storageHostname, APPROVED_STORAGE_HOSTNAME, 'M3_PREVIEW_MEDIA_STORAGE_HOST_NOT_APPROVED')
  const cdnHostname = assertHostname(mediaTarget.cdnHostname, 'M3_PREVIEW_MEDIA_CDN_HOST_REQUIRED')
  assert.ok(!PRODUCTION_MEDIA_HOSTS.has(cdnHostname), 'M3_PRODUCTION_MEDIA_CDN_FORBIDDEN')
  assert.match(cdnHostname, APPROVED_PREVIEW_CDN, 'M3_PREVIEW_MEDIA_CDN_NOT_APPROVED')

  const previewVars = {
    APP_ENV: 'staging',
    APP_BUILD_TARGET: 'public',
    APP_ORIGIN: FIXED_PREVIEW_ORIGIN,
    PREVIEW_NOINDEX: 'true',
    BUILD_SOURCE_SHA: sourceSha,
    PUBLIC_CATALOGUE_SOURCE: 'postgresql',
    RUNTIME_ROLE: 'staging',
    WRITE_FREEZE_MODE: 'false',
    ALLOW_ISOLATED_TEST_WRITES: 'true',
    ADMIN_TEST_DB_ROLE: 'dpg_admin_m3_test',
    PREVIEW_MEDIA_TARGET_ISOLATED: 'true',
    BUNNY_STORAGE_ZONE_NAME: mediaTarget.storageZoneName,
    BUNNY_STORAGE_HOSTNAME: storageHostname,
    BUNNY_CDN_HOSTNAME: cdnHostname,
  }

  return {
    name: FIXED_PREVIEW_WORKER,
    compatibility_date: '2026-08-30',
    compatibility_flags: ['nodejs_compat'],
    main: 'combined/worker.mjs',
    workers_dev: true,
    preview_urls: true,
    no_bundle: true,
    rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }],
    assets: { directory: 'combined/assets', binding: 'ASSETS', not_found_handling: 'none' },
    previews: {
      vars: previewVars,
      secrets: { required: [...PREVIEW_SECRETS] },
      hyperdrive: [
        { binding: 'PUBLIC_DB', id: publicHyperdriveId },
        { binding: 'HYPERDRIVE_ADMIN_NO_CACHE', id: adminHyperdriveId },
      ],
      images: { binding: 'IMAGES' },
      services: [],
      durable_objects: { bindings: [] },
      observability: {
        enabled: true,
        redact_query_string: true,
        logs: { enabled: true, persist: false, invocation_logs: true },
        traces: { enabled: false, persist: false },
      },
    },
  }
}

export function validateM3FixedPreviewConfig(config, expected) {
  assert.equal(config.name, FIXED_PREVIEW_WORKER)
  assert.equal(config.main, 'combined/worker.mjs')
  assert.equal(config.preview_urls, true)
  assert.deepEqual(config.previews.hyperdrive, [
    { binding: 'PUBLIC_DB', id: expected.publicHyperdriveId },
    { binding: 'HYPERDRIVE_ADMIN_NO_CACHE', id: expected.adminHyperdriveId },
  ])
  assert.equal(config.previews.vars.APP_ORIGIN, FIXED_PREVIEW_ORIGIN)
  assert.equal(config.previews.vars.BUILD_SOURCE_SHA, expected.sourceSha)
  assert.equal(config.previews.vars.PREVIEW_NOINDEX, 'true')
  assert.equal(config.previews.vars.PUBLIC_CATALOGUE_SOURCE, 'postgresql')
  assert.equal(config.previews.vars.ADMIN_TEST_DB_ROLE, 'dpg_admin_m3_test')
  assert.equal(config.previews.vars.PREVIEW_MEDIA_TARGET_ISOLATED, 'true')
  assert.equal(config.previews.vars.BUNNY_STORAGE_ZONE_NAME, APPROVED_PREVIEW_ZONE_NAME, 'M3_PREVIEW_MEDIA_ZONE_NAME_NOT_APPROVED')
  assert.equal(config.previews.vars.BUNNY_STORAGE_HOSTNAME, APPROVED_STORAGE_HOSTNAME, 'M3_PREVIEW_MEDIA_STORAGE_HOST_NOT_APPROVED')
  assert.match(config.previews.vars.BUNNY_CDN_HOSTNAME, APPROVED_PREVIEW_CDN, 'M3_PREVIEW_MEDIA_CDN_NOT_APPROVED')
  assert.ok(!PRODUCTION_MEDIA_HOSTS.has(config.previews.vars.BUNNY_CDN_HOSTNAME), 'M3_PRODUCTION_MEDIA_CDN_FORBIDDEN')
  assert.deepEqual(config.previews.images, { binding: 'IMAGES' }, 'M3_PREVIEW_IMAGES_BINDING_REQUIRED')
  assert.equal(config.previews.observability.redact_query_string, true)
  assert.equal(config.previews.observability.logs.persist, false)

  const productionProperties = ['vars', 'secrets', 'hyperdrive', 'services', 'durable_objects', 'observability']
  for (const property of productionProperties) assert.equal(property in config, false, `M3_PREVIEW_ONLY_CONFIG_REQUIRED:${property}`)
  return true
}
