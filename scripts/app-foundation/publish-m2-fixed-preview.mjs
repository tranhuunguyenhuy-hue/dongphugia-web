import assert from 'node:assert/strict'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { sanitizeM2CommandFailure } from './m2-public-diagnostics.mjs'
import { digestDirectory } from './public-worker-artifact.mjs'
import { FIXED_PREVIEW_NAME, FIXED_PREVIEW_WORKER, FIXED_PREVIEW_ORIGIN, isFixedPreviewDeploymentHost } from '../../apps/public/src/config/fixed-preview.mjs'

const ACCOUNT = 'd54f3402b9d112ab64d6135e0e3f1fb1'
const WORKER_ID = 'e50647603f1b4e73bed14e2e79c15d26'
const APP = '8f9650b6-faf3-4673-8e1c-70f297648ada'
const CF = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`
let phase = 'SOURCE_PIN', tokenId, policyId, tokenFile, before, evidencePath
const maskedValues = []
let expectedProduction, mutationsStopped = false
const evidence = { contract: 'dpg:m2-preview-publication:v1', status: 'UNKNOWN', rollbackPerformed: false }

export function validateM2PreviewConfig(config, source) {
  assert.equal(source.workerName, FIXED_PREVIEW_WORKER)
  assert.equal(source.previewName, FIXED_PREVIEW_NAME)
  assert.equal(config.name, FIXED_PREVIEW_WORKER)
  assert.equal(config.main, 'worker/index.js')
  assert.equal(config.no_bundle, true)
  assert.equal(config.preview_urls, true)
  assert.equal(config.workers_dev, true)
  assert.match(source.checkpoint || '', /^[a-f0-9]{40}$/)
  assert.equal(config.vars.APP_ENV, 'staging')
  assert.equal(config.vars.APP_ORIGIN, FIXED_PREVIEW_ORIGIN)
  assert.equal(config.vars.PREVIEW_NOINDEX, 'true')
  assert.equal(config.vars.PUBLIC_CATALOGUE_SOURCE, 'snapshot')
  assert.equal(config.vars.PUBLIC_CATALOGUE_CHECKPOINT, source.checkpoint)
  assert.deepEqual(config.previews.vars, config.vars)
  assert.deepEqual(config.previews.secrets, { required: [] })
  const permitted = new Set(['name','compatibility_date','compatibility_flags','main','workers_dev','preview_urls','no_bundle','rules','assets','vars','previews'])
  assert.ok(Object.keys(config).every(key => permitted.has(key)), 'M2_CONFIG_EXTRA_BINDING')
  assert.ok(Object.keys(config.previews).every(key => ['vars','secrets','hyperdrive','services','durable_objects'].includes(key)))
  assert.deepEqual(config.previews.hyperdrive, [])
  assert.deepEqual(config.previews.services, [])
  assert.deepEqual(config.previews.durable_objects, { bindings: [] })
  assert.ok(Object.keys(config.vars).every(key => ['APP_ENV','APP_BUILD_TARGET','APP_ORIGIN','PREVIEW_NOINDEX','PUBLIC_CATALOGUE_SOURCE','PUBLIC_CATALOGUE_CHECKPOINT'].includes(key)))
  assert.equal(config.vars.APP_BUILD_TARGET, 'public')
  assert.deepEqual(config.assets, { directory: 'assets', binding: 'ASSETS', not_found_handling: 'none' })
  assert.equal(config.compatibility_date, '2026-08-30')
  assert.deepEqual(config.compatibility_flags, ['nodejs_compat'])
}

async function cf(path, method = 'GET', body) {
  const response = await fetch(CF + path, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) })
  if (method === 'DELETE' && response.status === 204) return null
  const value = await response.json()
  if (!response.ok || value.success !== true) throw new Error(`M2_CF_API_${response.status}_${Number(value.errors?.[0]?.code) || 0}`)
  return value.result
}
async function gh(path) {
  const response = await fetch(`https://api.github.com/repos/tranhuunguyenhuy-hue/dongphugia.com.vn/${path}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20000), redirect: 'error' })
  if (!response.ok) throw new Error('M2_GITHUB_READ_REQUIRED')
  return response.json()
}
async function assertNoProductionRelease() {
  const runs = await gh('actions/workflows/v1-worker-release.yml/runs?per_page=20')
  const busy = runs.workflow_runs.filter(r => r.status !== 'completed')
  if (busy.length) { evidence.productionBusyRuns = busy.map(({id,status,head_sha}) => ({id,status,sourceSha:head_sha})); throw new Error('M2_PRODUCTION_RELEASE_BUSY') }
}
async function health() {
  const origins = ['https://www.dongphugia.vn', 'https://dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev']
  const values = []
  for (const origin of origins) {
    const response = await fetch(origin+'/api/health', { redirect: 'manual', signal: AbortSignal.timeout(20000) })
    if (response.status !== 200) throw new Error('M2_PRODUCTION_HEALTH_REQUIRED')
    values.push({ sourceSha: response.headers.get('x-dpg-source-sha'), body: await response.json() })
  }
  assert.deepEqual(values[0], values[1], 'M2_PRODUCTION_ORIGINS_MISMATCH')
  return values[0]
}
const signature = value => JSON.stringify(value)
async function productionState() {
  const [deployments, settings, subdomain, state] = await Promise.all([
    cf(`/workers/scripts/${FIXED_PREVIEW_WORKER}/deployments`), cf(`/workers/scripts/${FIXED_PREVIEW_WORKER}/settings`),
    cf(`/workers/scripts/${FIXED_PREVIEW_WORKER}/subdomain`), health(),
  ])
  const active = deployments.deployments[0]
  return { deploymentId: active.id, versions: active.versions, bindingsSignature: createHash('sha256').update(signature(settings.bindings)).digest('hex'),
    settingsSignature: createHash('sha256').update(signature(settings)).digest('hex'), subdomain, ...state }
}
async function ensureProductionUnchanged() {
  const after = await productionState()
  evidence.productionAfter = after
  if (signature(after) !== signature(expectedProduction || before)) { mutationsStopped = true; throw new Error('M2_PRODUCTION_CHANGED_STOP') }
}
async function run(command, args, env) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore','pipe','pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 64 * 1024 * 1024) child.kill() })
    child.stderr.on('data', chunk => { if (stderr.length < 100_000) stderr += chunk })
    child.on('error', reject)
    child.on('close', async code => {
      if (code === 0) return accept(stdout)
      if (evidencePath) await writeFile(join(resolve(evidencePath, '..'), 'command-failure.txt'), sanitizeM2CommandFailure(stderr, [...maskedValues, process.env.CLOUDFLARE_API_TOKEN]), { mode: 0o600 }).catch(() => {})
      reject(new Error('M2_CHILD_COMMAND_FAILED'))
    })
  })
}
async function cleanup() {
  const results = []
  evidence.ciAccessResources = { serviceTokenId: tokenId, policyId, maxLifetime: '1h' }
  if (mutationsStopped) {
    if (tokenFile) await rm(tokenFile, { force: true })
    evidence.ciAccessCleanup = ['API cleanup deferred: unexpected Production state; ephemeral token expires within 1h']
    return
  }
  if (policyId) results.push(await cf(`/access/apps/${APP}/policies/${policyId}`, 'DELETE').then(() => 'policy-removed').catch(() => 'policy-cleanup-failed'))
  if (tokenId) results.push(await cf(`/access/service_tokens/${tokenId}`, 'DELETE').then(() => 'token-revoked').catch(() => 'token-cleanup-failed'))
  if (tokenFile) await rm(tokenFile, { force: true })
  evidence.ciAccessCleanup = results
  if (results.some(value => value.endsWith('-failed'))) { evidence.status = 'FAIL'; process.exitCode = 1 }
}
async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main')
  assert.equal(process.env.GITHUB_REPOSITORY, 'tranhuunguyenhuy-hue/dongphugia.com.vn')
  assert.equal(process.env.GITHUB_WORKFLOW_REF, 'tranhuunguyenhuy-hue/dongphugia.com.vn/.github/workflows/v1-fixed-preview.yml@refs/heads/main')
  assert.equal(process.env.GITHUB_ACTOR, 'tranhuunguyenhuy-hue')
  assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT)
  assert.ok(process.env.CLOUDFLARE_API_TOKEN, 'M2_PREVIEW_PUBLISHER_TOKEN_REQUIRED')
  const [artifact, sourceSha] = process.argv.slice(2)
  assert.match(sourceSha || '', /^[a-f0-9]{40}$/)
  assert.equal(sourceSha, process.env.GITHUB_SHA)
  const root = resolve(artifact), output = resolve(process.env.RUNNER_TEMP, 'm2-hosted-evidence')
  await (await import('node:fs/promises')).mkdir(output, { recursive: true, mode: 0o700 })
  evidencePath = join(output, 'publication.json')
  const ref = await gh('git/ref/heads/main')
  assert.equal(ref.object.sha, sourceSha, 'M2_MAIN_ADVANCED')
  const checks = await gh(`commits/${sourceSha}/check-runs?per_page=100`)
  assert.ok(checks.check_runs.some(c => c.name === 'quality' && c.conclusion === 'success'), 'M2_REQUIRED_QUALITY_PASS')
  phase = 'ARTIFACT'
  const meta = JSON.parse(await readFile(join(root, 'm2-artifact.json'), 'utf8'))
  const preflight = JSON.parse(await readFile(join(root, 'm2-preflight.json'), 'utf8'))
  assert.equal(meta.contract, 'dpg:m2-fixed-preview-artifact:v1')
  assert.equal(meta.sourceSha, sourceSha)
  assert.deepEqual(preflight, { status: 'PASS', sourceSha, checkpoint: meta.checkpoint })
  const configText = await readFile(join(root, 'wrangler.fixed-preview.json'), 'utf8')
  validateM2PreviewConfig(JSON.parse(configText), meta)
  assert.equal(createHash('sha256').update(configText).digest('hex'), meta.configSha256)
  for (const folder of ['worker','assets']) {
    const digest = await digestDirectory(join(root, folder))
    assert.equal(digest.sha256, meta[folder].sha256)
    assert.equal(digest.fileCount, meta[folder].fileCount)
  }
  Object.assign(evidence, { sourceSha, checkpoint: meta.checkpoint, artifact: meta })
  phase = 'BEFORE'
  await assertNoProductionRelease()
  const worker = await cf(`/workers/workers/${WORKER_ID}`)
  assert.equal(worker.id, WORKER_ID, 'M2_EXISTING_PARENT_REQUIRED')
  const access = await cf(`/access/apps/${APP}`)
  assert.deepEqual(access.destinations, [{ type: 'preview_worker', worker_id: WORKER_ID }])
  assert.ok(access.policies.some(p => p.decision === 'allow' && p.include?.some(r => r.email?.email === 'tranhuunguyenhuy@gmail.com')))
  assert.ok(!access.policies.some(p => p.decision === 'bypass'), 'M2_ACCESS_BYPASS_FORBIDDEN')
  before = await productionState(); evidence.productionBefore = before
  assert.equal(before.sourceSha, meta.productionSourceSha, 'M2_PRODUCTION_BASELINE_CHANGED')
  assert.equal(before.body.catalogueMode, 'postgresql')
  assert.equal(before.subdomain.enabled, true)
  if (!before.subdomain.previews_enabled) {
    await assertNoProductionRelease()
    await ensureProductionUnchanged()
    const changed = await cf(`/workers/scripts/${FIXED_PREVIEW_WORKER}/subdomain`, 'POST', { enabled: before.subdomain.enabled, previews_enabled: true })
    assert.equal(changed.enabled, before.subdomain.enabled)
    assert.equal(changed.previews_enabled, true)
    expectedProduction = { ...before, subdomain: { ...before.subdomain, previews_enabled: true } }
    evidence.expectedParentChange = { previewsEnabled: true, revert: 'Restore the previous Preview URL flag only; do not roll back Production.' }
    await ensureProductionUnchanged()
  }
  phase = 'CI_ACCESS'
  const service = await cf('/access/service_tokens', 'POST', { name: `M2-staging-ci-${process.env.GITHUB_RUN_ID}`, duration: '1h' })
  tokenId = service.id
  assert.ok(service.client_id && service.client_secret, 'M2_SERVICE_TOKEN_REQUIRED')
  maskedValues.push(service.client_id, service.client_secret)
  console.log(`::add-mask::${service.client_id}`); console.log(`::add-mask::${service.client_secret}`)
  tokenFile = resolve(process.env.RUNNER_TEMP, 'm2-ci-access.json')
  await writeFile(tokenFile, JSON.stringify({ client_id: service.client_id, client_secret: service.client_secret }), { mode: 0o600, flag: 'wx' })
  const policy = await cf(`/access/apps/${APP}/policies`, 'POST', { name: `M2 CI ${process.env.GITHUB_RUN_ID}`, decision: 'non_identity', precedence: 2,
    include: [{ service_token: { token_id: tokenId } }], exclude: [], require: [] })
  assert.notEqual(policy.id, '516d7773-ba00-4f6e-b6ef-c5d4f545d544', 'M2_OWNER_POLICY_IMMUTABLE')
  assert.equal(policy.decision, 'non_identity')
  policyId = policy.id
  phase = 'PUBLISH'
  await assertNoProductionRelease()
  await ensureProductionUnchanged()
  const wrangler = resolve('tools/m2-preview/node_modules/wrangler/bin/wrangler.js')
  const raw = await run(process.execPath, [wrangler, 'preview', '--worker-name', FIXED_PREVIEW_WORKER, '--name', FIXED_PREVIEW_NAME,
    '--config', join(root, 'wrangler.fixed-preview.json'), '--ignore-base-config', '--tag', sourceSha, '--message', `M2 Public ${sourceSha}`, '--json'],
    { ...process.env, WRANGLER_SEND_METRICS: 'false' })
  const result = JSON.parse(raw)
  assert.equal(result.preview.name, FIXED_PREVIEW_NAME)
  assert.match(result.deployment.id, /^[a-f0-9-]{36}$/)
  assert.ok(result.preview.urls.map(url => new URL(url).origin).includes(FIXED_PREVIEW_ORIGIN))
  assert.ok(result.deployment.urls.length > 0)
  for (const url of result.deployment.urls) {
    const parsed = new URL(url)
    assert.ok(parsed.protocol === 'https:' && isFixedPreviewDeploymentHost(parsed.hostname))
  }
  const deployedEnv = result.deployment.env || Object.fromEntries((result.deployment.bindings || []).map(binding => [binding.name, binding]))
  assert.equal(deployedEnv.ASSETS?.type, 'assets', 'M2_ASSETS_BINDING_REQUIRED')
  const expectedVars = JSON.parse(configText).vars
  assert.deepEqual(Object.keys(deployedEnv).sort(), ['ASSETS', ...Object.keys(expectedVars)].sort(), 'M2_PREVIEW_BINDING_ISOLATION')
  for (const [name, value] of Object.entries(expectedVars)) {
    assert.equal(deployedEnv[name]?.type, 'plain_text')
    assert.equal(deployedEnv[name]?.text, value)
  }
  evidence.previewId = result.preview.id; evidence.deploymentId = result.deployment.id
  evidence.stableUrl = FIXED_PREVIEW_ORIGIN; evidence.immutableUrls = result.deployment.urls
  evidence.recovery = { status: 'UNKNOWN', reason: 'First candidate has no previously accepted staging deployment; preserve the pinned artifact for future re-upload to staging only.' }
  phase = 'AFTER'
  await ensureProductionUnchanged()
  phase = 'UAT'
  const env = { ...process.env, M2_PUBLIC_SNAPSHOT_CHECKPOINT: meta.checkpoint, M2_ACCESS_TOKEN_FILE: tokenFile,
    M1_NAVIGATION_DIAGNOSTICS: join(output, 'navigation.json'), M2_EVIDENCE_DIR: output }
  await run(process.execPath, ['scripts/app-foundation/public-navigation-acceptance.mjs', FIXED_PREVIEW_ORIGIN, sourceSha], env)
  await run(process.execPath, ['scripts/app-foundation/m2-public-acceptance.mjs', root, FIXED_PREVIEW_ORIGIN, sourceSha, ...result.deployment.urls], env)
  await ensureProductionUnchanged()
  evidence.status = 'PASS'; evidence.gateB = 'AWAITING_OWNER_AND_CHATGPT_ACCEPTANCE'
}
if (process.argv[1]?.endsWith('/publish-m2-fixed-preview.mjs')) main().catch(error => {
  const message = error instanceof Error ? error.message : ''
  evidence.status = 'FAIL'; evidence.phase = phase
  evidence.reason = /^M2_[A-Z0-9_]{1,100}$/.test(message) ? message : 'M2_VALIDATION_FAILED'
  process.exitCode = 1
}).finally(async () => {
  await cleanup()
  if (before) await ensureProductionUnchanged().catch(() => { evidence.status = 'FAIL'; evidence.reason = 'M2_PRODUCTION_CHANGED_STOP'; process.exitCode = 1 })
  if (evidencePath) await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ status: evidence.status, phase: evidence.phase || phase, reason: evidence.reason, deploymentId: evidence.deploymentId, gateB: evidence.gateB, rollbackPerformed: false }))
})
