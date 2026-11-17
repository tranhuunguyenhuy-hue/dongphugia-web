import assert from 'node:assert/strict'
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { sanitizeM2CloudflareApiFailure, sanitizeM2CommandFailure } from './m2-public-diagnostics.mjs'
import { digestEnvironmentWorkerArtifact } from './environment-worker-artifact-digest.mjs'
import { validateM3FixedPreviewConfig } from './m3-fixed-preview-config.mjs'
import { FIXED_PREVIEW_NAME, FIXED_PREVIEW_WORKER, FIXED_PREVIEW_ORIGIN, isFixedPreviewDeploymentHost } from '../../apps/public/src/config/fixed-preview.mjs'

// M3 publisher: ONE combined Public+Admin Worker artifact into the named Preview `staging` of the
// existing Production Worker. Main-only, exact SHA, owner actor. Never deploys or alters Production.
const ACCOUNT = 'd54f3402b9d112ab64d6135e0e3f1fb1'
const WORKER_ID = 'e50647603f1b4e73bed14e2e79c15d26'
const APP = '8f9650b6-faf3-4673-8e1c-70f297648ada'
const CF = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`
let phase = 'SOURCE_PIN', tokenId, policyId, tokenFile, secretsFile, before, evidencePath
const maskedValues = []
let expectedProduction, mutationsStopped = false
const evidence = { contract: 'dpg:m3-preview-publication:v1', status: 'UNKNOWN', rollbackPerformed: false }

async function cf(path, method = 'GET', body) {
  const response = await fetch(CF + path, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) })
  if (method === 'DELETE' && response.status === 204) return null
  const value = await response.json()
  if (!response.ok || value.success !== true) {
    evidence.cloudflareApiFailure = sanitizeM2CloudflareApiFailure(method, path, response.status, value.errors)
    throw new Error(`M3_CF_API_${response.status}_${Number(value.errors?.[0]?.code) || 0}`)
  }
  return value.result
}
async function gh(path) {
  const response = await fetch(`https://api.github.com/repos/tranhuunguyenhuy-hue/dongphugia.com.vn/${path}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20000), redirect: 'error' })
  if (!response.ok) throw new Error('M3_GITHUB_READ_REQUIRED')
  return response.json()
}
async function assertNoProductionRelease() {
  const runs = await gh('actions/workflows/v1-worker-release.yml/runs?per_page=20')
  const busy = runs.workflow_runs.filter(r => r.status !== 'completed')
  if (busy.length) { evidence.productionBusyRuns = busy.map(({id,status,head_sha}) => ({id,status,sourceSha:head_sha})); throw new Error('M3_PRODUCTION_RELEASE_BUSY') }
}
async function health() {
  const origins = ['https://www.dongphugia.vn', 'https://dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev']
  const values = []
  for (const origin of origins) {
    const response = await fetch(origin+'/api/health', { redirect: 'manual', signal: AbortSignal.timeout(20000) })
    if (response.status !== 200) throw new Error('M3_PRODUCTION_HEALTH_REQUIRED')
    values.push({ sourceSha: response.headers.get('x-dpg-source-sha'), body: await response.json() })
  }
  assert.deepEqual(values[0], values[1], 'M3_PRODUCTION_ORIGINS_MISMATCH')
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
  if (signature(after) !== signature(expectedProduction || before)) { mutationsStopped = true; throw new Error('M3_PRODUCTION_CHANGED_STOP') }
}
async function run(command, args, env) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore','pipe','pipe'] })
    let stderr = ''
    child.stdout.resume() // Structured output is read from a dedicated JSONL file, never from raw API/module logs.
    child.stderr.on('data', chunk => { if (stderr.length < 100_000) stderr += chunk })
    child.on('error', reject)
    child.on('close', async code => {
      if (code === 0) return accept()
      if (evidencePath) await writeFile(join(resolve(evidencePath, '..'), 'command-failure.txt'), sanitizeM2CommandFailure(stderr, [...maskedValues, process.env.CLOUDFLARE_API_TOKEN]), { mode: 0o600 }).catch(() => {})
      reject(new Error('M3_CHILD_COMMAND_FAILED'))
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
async function accessFetch(path, token, init = {}) {
  return fetch(FIXED_PREVIEW_ORIGIN + path, { redirect: 'manual', signal: AbortSignal.timeout(20000), ...init,
    headers: { 'CF-Access-Client-Id': token.client_id, 'CF-Access-Client-Secret': token.client_secret, ...(init.headers || {}) } })
}
async function adminSmoke(token, sourceSha) {
  const out = {}
  const login = await accessFetch('/admin/login', token)
  out.login = { status: login.status, noindex: /noindex/i.test(login.headers.get('x-robots-tag') || '') }
  assert.equal(login.status, 200, 'M3_ADMIN_LOGIN_PAGE_REQUIRED'); assert.ok(out.login.noindex, 'M3_ADMIN_NOINDEX_REQUIRED')
  for (const path of ['/admin/products', '/admin/users', '/admin/orders']) {
    const response = await accessFetch(path, token)
    out[path] = response.status
    assert.ok([302, 303, 307].includes(response.status) && /\/admin\/login/.test(response.headers.get('location') || ''), 'M3_ADMIN_UNAUTHENTICATED_REDIRECT_REQUIRED')
  }
  const forged = await accessFetch('/admin/products', token, { headers: { cookie: 'dpg-admin-session=forged' } })
  out.forgedCookie = forged.status
  assert.ok([302, 303, 307, 401].includes(forged.status), 'M3_ADMIN_FORGED_SESSION_DENIED_REQUIRED')
  const health = await accessFetch('/api/health', token)
  assert.equal(health.status, 200, 'M3_PREVIEW_HEALTH_REQUIRED')
  assert.equal(health.headers.get('x-dpg-source-sha'), sourceSha, 'M3_PREVIEW_SOURCE_SHA_REQUIRED')
  out.healthBody = await health.json()
  return out
}
async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main')
  assert.equal(process.env.GITHUB_REPOSITORY, 'tranhuunguyenhuy-hue/dongphugia.com.vn')
  assert.equal(process.env.GITHUB_WORKFLOW_REF, 'tranhuunguyenhuy-hue/dongphugia.com.vn/.github/workflows/v1-fixed-preview.yml@refs/heads/main')
  assert.equal(process.env.GITHUB_ACTOR, 'tranhuunguyenhuy-hue')
  assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT)
  assert.ok(process.env.CLOUDFLARE_API_TOKEN, 'M3_PREVIEW_PUBLISHER_TOKEN_REQUIRED')
  assert.ok(process.env.M3_PREVIEW_BUNNY_STORAGE_API_KEY, 'M3_PREVIEW_BUNNY_KEY_REQUIRED')
  const [artifact, sourceSha] = process.argv.slice(2)
  assert.match(sourceSha || '', /^[a-f0-9]{40}$/)
  assert.equal(sourceSha, process.env.GITHUB_SHA)
  const root = resolve(artifact), output = resolve(process.env.RUNNER_TEMP, 'm3-hosted-evidence')
  await mkdir(output, { recursive: true, mode: 0o700 })
  evidencePath = join(output, 'publication.json')
  const ref = await gh('git/ref/heads/main')
  assert.equal(ref.object.sha, sourceSha, 'M3_MAIN_ADVANCED')
  const checks = await gh(`commits/${sourceSha}/check-runs?per_page=100`)
  assert.ok(checks.check_runs.some(c => c.name === 'quality' && c.conclusion === 'success'), 'M3_REQUIRED_QUALITY_PASS')
  phase = 'ARTIFACT'
  const meta = JSON.parse(await readFile(join(root, 'm3-artifact.json'), 'utf8'))
  assert.equal(meta.contract, 'dpg:m3-fixed-preview-artifact:v1')
  assert.equal(meta.sourceSha, sourceSha)
  const configText = await readFile(join(root, 'wrangler.m3-fixed-preview.json'), 'utf8')
  assert.equal(createHash('sha256').update(configText).digest('hex'), meta.configSha256)
  const config = JSON.parse(configText)
  validateM3FixedPreviewConfig(config, { sourceSha, publicHyperdriveId: meta.hyperdrive.public.id, adminHyperdriveId: meta.hyperdrive.admin.id })
  assert.deepEqual(await digestEnvironmentWorkerArtifact(join(root, 'combined/public/server')), meta.hashes.publicServer)
  assert.deepEqual(await digestEnvironmentWorkerArtifact(join(root, 'combined/admin/server')), meta.hashes.adminServer)
  assert.deepEqual(await digestEnvironmentWorkerArtifact(join(root, 'combined/assets')), meta.hashes.assets)
  assert.equal(createHash('sha256').update(await readFile(join(root, 'combined/worker.mjs'))).digest('hex'), meta.hashes.worker)
  Object.assign(evidence, { sourceSha, artifact: meta })
  phase = 'BEFORE'
  await assertNoProductionRelease()
  const worker = await cf(`/workers/workers/${WORKER_ID}`)
  assert.equal(worker.id, WORKER_ID, 'M3_EXISTING_PARENT_REQUIRED')
  const access = await cf(`/access/apps/${APP}`)
  assert.deepEqual(access.destinations, [{ type: 'preview_worker', worker_id: WORKER_ID }])
  assert.ok(access.policies.some(p => p.decision === 'allow' && p.include?.some(r => r.email?.email === 'tranhuunguyenhuy@gmail.com')))
  assert.ok(!access.policies.some(p => p.decision === 'bypass'), 'M3_ACCESS_BYPASS_FORBIDDEN')
  before = await productionState(); evidence.productionBefore = before
  assert.equal(before.body.catalogueMode, 'postgresql')
  assert.equal(before.subdomain.enabled, true)
  assert.equal(before.subdomain.previews_enabled, true, 'M3_PREVIEW_URLS_ALREADY_ENABLED_REQUIRED')
  const productionHyperdrives = (await cf(`/workers/scripts/${FIXED_PREVIEW_WORKER}/settings`)).bindings.filter(b => b.type === 'hyperdrive').map(b => String(b.id || b.config_id || '').toLowerCase())
  for (const id of [meta.hyperdrive.public.id, meta.hyperdrive.admin.id]) assert.ok(!productionHyperdrives.includes(id.toLowerCase()), 'M3_PRODUCTION_HYPERDRIVE_REUSE_FORBIDDEN')
  phase = 'CI_ACCESS'
  const service = await cf('/access/service_tokens', 'POST', { name: `M3-staging-ci-${process.env.GITHUB_RUN_ID}`, duration: '1h' })
  tokenId = service.id
  assert.ok(service.client_id && service.client_secret, 'M3_SERVICE_TOKEN_REQUIRED')
  maskedValues.push(service.client_id, service.client_secret)
  console.log(`::add-mask::${service.client_id}`); console.log(`::add-mask::${service.client_secret}`)
  tokenFile = resolve(process.env.RUNNER_TEMP, 'm3-ci-access.json')
  await writeFile(tokenFile, JSON.stringify({ client_id: service.client_id, client_secret: service.client_secret }), { mode: 0o600, flag: 'wx' })
  const policy = await cf(`/access/apps/${APP}/policies`, 'POST', { name: `M3 CI ${process.env.GITHUB_RUN_ID}`, decision: 'non_identity', precedence: 2, session_duration: '1h',
    include: [{ service_token: { token_id: tokenId } }], exclude: [], require: [] })
  assert.notEqual(policy.id, '516d7773-ba00-4f6e-b6ef-c5d4f545d544', 'M3_OWNER_POLICY_IMMUTABLE')
  assert.equal(policy.decision, 'non_identity')
  policyId = policy.id
  phase = 'PUBLISH'
  await assertNoProductionRelease()
  await ensureProductionUnchanged()
  const revalidate = randomBytes(32).toString('hex')
  maskedValues.push(revalidate, process.env.M3_PREVIEW_BUNNY_STORAGE_API_KEY)
  console.log(`::add-mask::${revalidate}`)
  secretsFile = resolve(process.env.RUNNER_TEMP, 'm3-preview-secrets.json')
  await writeFile(secretsFile, JSON.stringify({ ADMIN_PREVIEW_MEDIA_KEY: process.env.M3_PREVIEW_BUNNY_STORAGE_API_KEY, REVALIDATE_SECRET: revalidate }), { mode: 0o600, flag: 'wx' })
  const wrangler = resolve('tools/m2-preview/node_modules/wrangler/bin/wrangler.js')
  const cliOutput = resolve(process.env.RUNNER_TEMP, 'm3-wrangler-output.jsonl')
  await run(process.execPath, [wrangler, 'preview', '--worker-name', FIXED_PREVIEW_WORKER, '--name', FIXED_PREVIEW_NAME,
    '--config', join(root, 'wrangler.m3-fixed-preview.json'), '--ignore-base-config', '--secrets-file', secretsFile, '--tag', sourceSha, '--message', `M3 Admin ${sourceSha}`, '--json'],
    { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_OUTPUT_FILE_PATH: cliOutput })
  await rm(secretsFile, { force: true })
  const records = (await readFile(cliOutput, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const published = records.filter(record => record.type === 'preview').at(-1)
  assert.equal(published?.preview_name, FIXED_PREVIEW_NAME, 'M3_CLI_PREVIEW_OUTPUT_REQUIRED')
  assert.match(published.preview_id || '', /^[a-f0-9]{32}$/)
  assert.match(published.deployment_id || '', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/)
  const preview = await cf(`/workers/workers/${WORKER_ID}/previews/${published.preview_id}`)
  const deployment = await cf(`/workers/workers/${WORKER_ID}/previews/${published.preview_id}/deployments/${published.deployment_id}`)
  assert.equal(preview.name, FIXED_PREVIEW_NAME)
  assert.ok(preview.urls.map(url => new URL(url).origin).includes(FIXED_PREVIEW_ORIGIN))
  assert.ok(deployment.urls.length > 0)
  for (const url of deployment.urls) { const parsed = new URL(url); assert.ok(parsed.protocol === 'https:' && isFixedPreviewDeploymentHost(parsed.hostname)) }
  const deployedEnv = deployment.env || Object.fromEntries((deployment.bindings || []).map(binding => [binding.name, binding]))
  const expectedVars = config.previews.vars
  assert.equal(deployedEnv.ASSETS?.type, 'assets', 'M3_ASSETS_BINDING_REQUIRED')
  assert.deepEqual(Object.keys(deployedEnv).sort(), ['ASSETS', 'PUBLIC_DB', 'HYPERDRIVE_ADMIN_NO_CACHE', 'ADMIN_PREVIEW_MEDIA_KEY', 'REVALIDATE_SECRET', 'IMAGES', ...Object.keys(expectedVars)].sort(), 'M3_PREVIEW_BINDING_ISOLATION')
  assert.equal(deployedEnv.IMAGES?.type, 'images', 'M3_IMAGES_BINDING_REQUIRED')
  assert.equal(deployedEnv.PUBLIC_DB?.type, 'hyperdrive'); assert.equal(deployedEnv.HYPERDRIVE_ADMIN_NO_CACHE?.type, 'hyperdrive')
  for (const [name, value] of Object.entries(expectedVars)) { assert.equal(deployedEnv[name]?.type, 'plain_text'); assert.equal(deployedEnv[name]?.text, value) }
  evidence.hyperdriveReadback = {}
  for (const [name, expected] of [['PUBLIC_DB', meta.hyperdrive.public.id], ['HYPERDRIVE_ADMIN_NO_CACHE', meta.hyperdrive.admin.id]]) {
    const actual = deployedEnv[name]?.id ?? deployedEnv[name]?.config_id ?? deployedEnv[name]?.hyperdrive_id
    if (actual !== undefined) assert.equal(String(actual).toLowerCase(), expected.toLowerCase(), 'M3_HYPERDRIVE_ID_READBACK_MISMATCH')
    evidence.hyperdriveReadback[name] = actual === undefined ? 'ID_NOT_EXPOSED_BY_PROVIDER' : 'EXACT_MATCH'
  }
  evidence.previewId = preview.id; evidence.deploymentId = deployment.id
  evidence.stableUrl = FIXED_PREVIEW_ORIGIN; evidence.immutableUrls = deployment.urls
  phase = 'AFTER'
  await ensureProductionUnchanged()
  phase = 'SMOKE'
  const token = JSON.parse(await readFile(tokenFile, 'utf8'))
  evidence.adminSmoke = await adminSmoke(token, sourceSha)
  // Public regression against TEST data is recorded as evidence; full Public/Admin UAT is a separate hosted gate.
  evidence.publicNavigation = await run(process.execPath, ['scripts/app-foundation/public-navigation-acceptance.mjs', FIXED_PREVIEW_ORIGIN, sourceSha],
    { ...process.env, M2_ACCESS_TOKEN_FILE: tokenFile, M1_NAVIGATION_DIAGNOSTICS: join(output, 'navigation.json'), M2_EVIDENCE_DIR: output }).then(() => 'PASS', () => 'FAIL_REVIEW_REQUIRED')
  await ensureProductionUnchanged()
  evidence.status = 'PASS'; evidence.gateC = 'AWAITING_HOSTED_UAT_AND_OWNER_ACCEPTANCE'
}
if (process.argv[1]?.endsWith('/publish-m3-fixed-preview.mjs')) main().catch(error => {
  const message = error instanceof Error ? error.message : ''
  evidence.status = 'FAIL'; evidence.phase = phase
  evidence.reason = /^M3_[A-Z0-9_]{1,100}$/.test(message) ? message : 'M3_VALIDATION_FAILED'
  process.exitCode = 1
}).finally(async () => {
  if (secretsFile) await rm(secretsFile, { force: true }).catch(() => {})
  await cleanup()
  if (before) await ensureProductionUnchanged().catch(() => { evidence.status = 'FAIL'; evidence.reason = 'M3_PRODUCTION_CHANGED_STOP'; process.exitCode = 1 })
  if (evidencePath) await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ status: evidence.status, phase: evidence.phase || phase, reason: evidence.reason, deploymentId: evidence.deploymentId, gateC: evidence.gateC, rollbackPerformed: false }))
})
