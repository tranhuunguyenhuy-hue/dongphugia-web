import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { digestEnvironmentWorkerArtifact } from './environment-worker-artifact-digest.mjs'
import {
  createM3FixedPreviewConfig,
  validateM3FixedPreviewConfig,
} from './m3-fixed-preview-config.mjs'
import {
  FIXED_PREVIEW_NAME,
  FIXED_PREVIEW_ORIGIN,
  FIXED_PREVIEW_WORKER,
} from '../../apps/public/src/config/fixed-preview.mjs'

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`M3_${name}_REQUIRED`)
  return value
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error('M3_ASSEMBLY_ARGUMENTS_INVALID')
    values[key.slice(2)] = value
    index += 1
  }
  return values
}

async function assemble({ artifactRoot, sourceSha }) {
  const root = path.resolve(artifactRoot)
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'))
  assert.equal(manifest.contract, 'dpg:m3-fixed-preview-combined-worker:v1', 'M3_BUILD_MANIFEST_REQUIRED')
  assert.equal(manifest.sourceSha, sourceSha, 'M3_BUILD_SOURCE_SHA_MISMATCH')
  assert.equal(manifest.workerName, FIXED_PREVIEW_WORKER, 'M3_FIXED_WORKER_REQUIRED')
  assert.equal(manifest.previewName, FIXED_PREVIEW_NAME, 'M3_FIXED_PREVIEW_REQUIRED')
  assert.equal(manifest.previewOrigin, FIXED_PREVIEW_ORIGIN, 'M3_FIXED_PREVIEW_ORIGIN_REQUIRED')

  const [publicServer, adminServer, assets, workerBytes] = await Promise.all([
    digestEnvironmentWorkerArtifact(path.join(root, 'combined/public/server')),
    digestEnvironmentWorkerArtifact(path.join(root, 'combined/admin/server')),
    digestEnvironmentWorkerArtifact(path.join(root, 'combined/assets')),
    readFile(path.join(root, 'combined/worker.mjs')),
  ])
  assert.deepEqual(publicServer, manifest.hashes.publicServer, 'M3_PUBLIC_SERVER_DIGEST_MISMATCH')
  assert.deepEqual(adminServer, manifest.hashes.adminServer, 'M3_ADMIN_SERVER_DIGEST_MISMATCH')
  assert.deepEqual(assets, manifest.hashes.assets, 'M3_ASSETS_DIGEST_MISMATCH')
  assert.equal(createHash('sha256').update(workerBytes).digest('hex'), manifest.hashes.worker, 'M3_WORKER_DIGEST_MISMATCH')

  const productionHyperdriveIds = (process.env.M3_PRODUCTION_HYPERDRIVE_IDS ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean)
  const productionHyperdriveInventoryVerified = process.env.M3_PRODUCTION_HYPERDRIVE_INVENTORY_VERIFIED === 'true'
  const mediaTarget = {
    zoneId: required('M3_PREVIEW_MEDIA_ZONE_ID'),
    productionZoneId: required('M3_PRODUCTION_MEDIA_ZONE_ID'),
    storageZoneName: required('M3_PREVIEW_MEDIA_ZONE_NAME'),
    storageHostname: required('M3_PREVIEW_MEDIA_STORAGE_HOSTNAME'),
    cdnHostname: required('M3_PREVIEW_MEDIA_CDN_HOSTNAME'),
  }
  const publicHyperdriveId = required('M3_TEST_PUBLIC_HYPERDRIVE_ID')
  const adminHyperdriveId = required('M3_TEST_ADMIN_HYPERDRIVE_ID')
  const orderIntakeHyperdriveId = process.env.M3_TEST_ORDER_INTAKE_HYPERDRIVE_ID?.trim() || undefined
  const config = createM3FixedPreviewConfig({
    sourceSha,
    publicHyperdriveId,
    adminHyperdriveId,
    orderIntakeHyperdriveId,
    productionHyperdriveIds,
    productionHyperdriveInventoryVerified,
    mediaTarget,
  })
  validateM3FixedPreviewConfig(config, { sourceSha, publicHyperdriveId, adminHyperdriveId, orderIntakeHyperdriveId })

  const configText = `${JSON.stringify(config, null, 2)}\n`
  const configSha256 = createHash('sha256').update(configText).digest('hex')
  await writeFile(path.join(root, 'wrangler.m3-fixed-preview.json'), configText, { mode: 0o600 })
  const metadata = {
    contract: 'dpg:m3-fixed-preview-artifact:v1',
    sourceSha,
    workerName: FIXED_PREVIEW_WORKER,
    previewName: FIXED_PREVIEW_NAME,
    previewOrigin: FIXED_PREVIEW_ORIGIN,
    configSha256,
    hyperdrive: {
      public: { id: publicHyperdriveId, access: 'read-only-test', cache: 'none' },
      admin: { id: adminHyperdriveId, role: 'dpg_admin_m3_test', cache: 'disabled' },
      ...(orderIntakeHyperdriveId ? { orderIntake: { id: orderIntakeHyperdriveId, role: 'dpg_order_intake_login', cache: 'disabled' } } : {}),
      productionIdsExcluded: true,
      productionInventoryVerified: productionHyperdriveInventoryVerified,
    },
    media: {
      previewZoneId: String(mediaTarget.zoneId),
      productionZoneId: String(mediaTarget.productionZoneId),
      isolated: true,
    },
    hashes: manifest.hashes,
  }
  await writeFile(path.join(root, 'm3-artifact.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 })
  return metadata
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const sourceSha = args['source-sha']
  assert.match(sourceSha || '', /^[a-f0-9]{40}$/, 'M3_SOURCE_SHA_REQUIRED')
  const metadata = await assemble({ artifactRoot: args.output ?? 'dist/m3-fixed-preview', sourceSha })
  process.stdout.write(`${JSON.stringify({ status: 'PASS', stage: 'M3_PREVIEW_ARTIFACT', sourceSha, configSha256: metadata.configSha256, previewName: metadata.previewName })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const code = error instanceof Error && /^M3_[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'M3_ARTIFACT_ASSEMBLY_FAILED'
    process.stderr.write(`${code}\n`)
    process.exitCode = 1
  })
}

export { assemble }
