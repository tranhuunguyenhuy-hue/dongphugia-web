import assert from 'node:assert/strict'
import {
  FIXED_PREVIEW_NAME,
  FIXED_PREVIEW_ORIGIN,
  FIXED_PREVIEW_WORKER,
} from '../../apps/public/src/config/fixed-preview.mjs'

const SOURCE_SHA = /^[a-f0-9]{40}$/
const HYPERDRIVE_ID = /^[a-f0-9]{32}$/i
const PREVIEW_SECRETS = ['BUNNY_STORAGE_API_KEY', 'REVALIDATE_SECRET']
const PRODUCTION_MEDIA_HOSTS = new Set(['cdn.dongphugia.com.vn', 'cdn.dongphugia.vn'])

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
  assert.ok(typeof mediaTarget.storageZoneName === 'string' && mediaTarget.storageZoneName.length > 0, 'M3_PREVIEW_MEDIA_ZONE_NAME_REQUIRED')
  const storageHostname = assertHostname(mediaTarget.storageHostname, 'M3_PREVIEW_MEDIA_STORAGE_HOST_REQUIRED')
  const cdnHostname = assertHostname(mediaTarget.cdnHostname, 'M3_PREVIEW_MEDIA_CDN_HOST_REQUIRED')
  assert.ok(!PRODUCTION_MEDIA_HOSTS.has(cdnHostname), 'M3_PRODUCTION_MEDIA_CDN_FORBIDDEN')

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
  assert.equal(config.previews.observability.redact_query_string, true)
  assert.equal(config.previews.observability.logs.persist, false)

  const productionProperties = ['vars', 'secrets', 'hyperdrive', 'services', 'durable_objects', 'observability']
  for (const property of productionProperties) assert.equal(property in config, false, `M3_PREVIEW_ONLY_CONFIG_REQUIRED:${property}`)
  return true
}
