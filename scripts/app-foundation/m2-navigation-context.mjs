import assert from 'node:assert/strict'
import { readFileSync, lstatSync } from 'node:fs'
import { FIXED_PREVIEW_ORIGIN, isFixedPreviewDeploymentHost } from '../../apps/public/src/config/fixed-preview.mjs'

export function navigationTarget(base, env = process.env) {
  const url = new URL(base)
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'NAVIGATION_ORIGIN_REQUIRED')
  const origin = url.origin, snapshot = env.M2_PUBLIC_SNAPSHOT_CHECKPOINT
  const local = /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)
  const hosted = url.protocol === 'https:' && !url.port && (origin === FIXED_PREVIEW_ORIGIN || isFixedPreviewDeploymentHost(url.hostname))
  if (snapshot) {
    assert.match(snapshot, /^[a-f0-9]{40}$/, 'M2_CHECKPOINT_REQUIRED')
    assert.ok(local || hosted, 'M2_PREVIEW_ORIGIN_REQUIRED')
  } else assert.ok(origin === 'https://www.dongphugia.vn' || local, 'M1_ORIGIN_REQUIRED')
  return { origin, snapshotMode: Boolean(snapshot), hosted }
}
export function readM2AccessHeaders(origin, file) {
  if (!file) return {}
  const { hosted } = navigationTarget(origin, { M2_PUBLIC_SNAPSHOT_CHECKPOINT: 'a'.repeat(40) })
  assert.ok(hosted, 'M2_ACCESS_PREVIEW_ONLY')
  assert.ok(lstatSync(file).isFile() && (lstatSync(file).mode & 0o077) === 0, 'M2_ACCESS_PRIVATE_FILE_REQUIRED')
  let value
  try { value = JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error('M2_ACCESS_FILE_INVALID') }
  for (const key of ['client_id', 'client_secret']) assert.ok(typeof value[key] === 'string' && value[key].length > 0 && value[key].length < 512 && !/[\r\n]/.test(value[key]), 'M2_ACCESS_FILE_INVALID')
  return { 'CF-Access-Client-Id': value.client_id, 'CF-Access-Client-Secret': value.client_secret }
}
export async function applyM2BrowserAccess(context, origin, accessHeaders) {
  if (!Object.keys(accessHeaders).length) return
  await context.route('**/*', async route => {
    const request = route.request(), headers = { ...request.headers() }
    // Never forward the CI credential to Bunny, Supabase media or Production.
    for (const key of Object.keys(headers)) if (/^cf-access-client-(?:id|secret)$/i.test(key)) delete headers[key]
    if (new URL(request.url()).origin === origin) Object.assign(headers, accessHeaders)
    await route.continue({ headers })
  })
}
