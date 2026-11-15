import fs from 'node:fs'

function fail(reason) {
  throw new Error(`ROLLBACK_CANDIDATE_${reason}`)
}

function deploymentsFrom(value) {
  const deployments = Array.isArray(value) ? value : value?.deployments ?? value?.result?.deployments
  if (!Array.isArray(deployments) || deployments.length === 0) fail('DEPLOYMENTS_MISSING')
  return deployments
}

function versionFrom(value) {
  return value?.version ?? value?.result ?? value
}

export function validatePublicRollbackCandidate({
  deploymentsDocument,
  versionDocument,
  healthHeaders,
  health,
  hyperdriveId,
}) {
  const deployments = deploymentsFrom(deploymentsDocument)
  const current = deployments.reduce((latest, item) =>
    !latest || item.created_on > latest.created_on ? item : latest, null)
  const active = current?.versions?.filter(version => version.percentage === 100) ?? []
  const versionId = active[0]?.version_id
  if (!/^[a-f0-9-]{36}$/i.test(versionId ?? '') || active.length !== 1) fail('ACTIVE_VERSION_INVALID')

  const version = versionFrom(versionDocument)
  if (!version || (version.id && version.id !== versionId)) fail('VERSION_METADATA_MISMATCH')
  const bindings = version.resources?.bindings ?? []
  const binding = name => bindings.filter(item => item.name === name)
  const appEnv = binding('APP_ENV')
  const appOrigin = binding('APP_ORIGIN')
  const catalogueSource = binding('PUBLIC_CATALOGUE_SOURCE')
  if (appEnv.length !== 1 || appEnv[0].text !== 'production'
    || appOrigin.length !== 1 || appOrigin[0].text !== 'https://www.dongphugia.vn'
    || catalogueSource.length !== 1) fail('PUBLIC_PRODUCTION_BINDINGS_INVALID')

  const sourceSha = String(healthHeaders).match(/^x-dpg-source-sha:\s*([a-f0-9]{40})\s*$/im)?.[1]
  if (!sourceSha || health?.status !== 'ok') fail('LIVE_HEALTH_INVALID')

  if (catalogueSource[0].text === 'postgresql') {
    const db = binding('PUBLIC_DB')
    if (db.length !== 1 || db[0].type !== 'hyperdrive'
      || !/^[a-f0-9]{32}$/i.test(hyperdriveId ?? '')
      || (db[0].id ?? db[0].hyperdrive_id) !== hyperdriveId) fail('POSTGRES_BINDING_INVALID')
    if (health.catalogueMode !== 'postgresql' || health.publicProducts !== 5964
      || health.listingProducts !== 5362 || health.publishedBlogs !== 10) fail('POSTGRES_HEALTH_INVALID')
    return { mode: 'postgresql', versionId, sourceSha, checkpoint: '' }
  }

  if (catalogueSource[0].text === 'snapshot') {
    if (bindings.some(item => item.name === 'PUBLIC_DB' || item.type === 'hyperdrive')) fail('SNAPSHOT_HAS_DATABASE_BINDING')
    if (health.catalogueMode !== 'verified-snapshot' || health.publicProducts !== 5223
      || health.listingProducts !== 4853 || !/^[a-f0-9]{40}$/.test(health.catalogueCheckpoint ?? '')) {
      fail('SNAPSHOT_HEALTH_INVALID')
    }
    return { mode: 'verified-snapshot', versionId, sourceSha, checkpoint: health.catalogueCheckpoint }
  }

  fail('CATALOGUE_SOURCE_INVALID')
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [deploymentsPath, versionPath, healthHeadersPath, healthPath] = process.argv.slice(2)
  if (![deploymentsPath, versionPath, healthHeadersPath, healthPath].every(Boolean)) fail('ARGUMENTS')
  const readJson = path => JSON.parse(fs.readFileSync(path, 'utf8'))
  const candidate = validatePublicRollbackCandidate({
    deploymentsDocument: readJson(deploymentsPath),
    versionDocument: readJson(versionPath),
    healthHeaders: fs.readFileSync(healthHeadersPath, 'utf8'),
    health: readJson(healthPath),
    hyperdriveId: process.env.V1_PUBLIC_HYPERDRIVE_ID,
  })
  fs.appendFileSync(process.env.GITHUB_OUTPUT, [
    `version_id=${candidate.versionId}`,
    `mode=${candidate.mode}`,
    `source_sha=${candidate.sourceSha}`,
    `checkpoint=${candidate.checkpoint}`,
  ].join('\n') + '\n')
  console.log(`ROLLBACK_CANDIDATE status=PASS mode=${candidate.mode} version=${candidate.versionId} source_sha=${candidate.sourceSha}`)
}
