import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { connect, closeConnections } from '../catalogue-direct/run.mjs'
import { verifyM2SnapshotReadAccess } from './verify-m2-snapshot-read-access.mjs'
import { buildM2PublicSnapshot, type CaptureEntry, type CaptureCategory } from './m2-public-snapshot.mjs'
import type { PublicProductRow } from '../../apps/public/src/runtime/live-public-catalogue'
// Reuse tsx's CommonJS loader for root TS aliases, matching the existing
// protected projection runner. Native ESM cannot name-import the root CJS sanitizer.
const require = createRequire(import.meta.url)
const { M1_PUBLIC_CAPTURE_SQL, M1_PUBLIC_CATEGORY_CAPTURE_SQL, mapLiveProduct, mapLiveProductDetail } = require('../../apps/public/src/runtime/live-public-catalogue.ts') as typeof import('../../apps/public/src/runtime/live-public-catalogue')
const { LIVE_BLOG, PUBLIC_BLOG_CATEGORIES_SQL, mapPublicBlogRecords } = require('../../apps/public/src/runtime/live-public-blog.ts') as typeof import('../../apps/public/src/runtime/live-public-blog')
import type { LegacyBlogCategory } from '../../apps/public/src/runtime/legacy-blog'

type CaptureRow = PublicProductRow & { listing_eligible: boolean; search_eligible: boolean; capture_priority: number | null; capture_sort_order: number | null }
let phase = 'RUNNER_IDENTITY'
async function productionHealth() {
  const response = await fetch('https://www.dongphugia.vn/api/health', { signal: AbortSignal.timeout(15000), redirect: 'error' })
  const sourceSha = response.headers.get('x-dpg-source-sha')
  const body = await response.json() as {status:string;catalogueMode:string;publicProducts:number;listingProducts:number;publishedBlogs:number}
  if (!response.ok || !/^[a-f0-9]{40}$/.test(sourceSha || '') || body.status !== 'ok'
    || body.catalogueMode !== 'postgresql' || ![body.publicProducts, body.listingProducts, body.publishedBlogs].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('M2_PRODUCTION_IDENTITY_REQUIRED')
  return { sourceSha: sourceSha!, body }
}
async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main'
    || process.env.GITHUB_ACTOR !== 'tranhuunguyenhuy-hue'
    || process.env.GITHUB_WORKFLOW_REF !== 'tranhuunguyenhuy-hue/dongphugia.com.vn/.github/workflows/v1-fixed-preview.yml@refs/heads/main'
    || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '') || !process.env.RUNNER_TEMP) throw new Error('M2_PROTECTED_RUNNER_REQUIRED')
  const before = await productionHealth()
  phase = 'CONNECT_READ'
  if (!process.env.DIRECT_TARGET_READ_DATABASE_URL?.trim()) throw new Error('M2_SELECT_SECRET_MISSING')
  if (!process.env.DIRECT_TARGET_CA?.trim()) throw new Error('M2_SELECT_CA_MISSING')
  const client = await connect('read')
  const access = await verifyM2SnapshotReadAccess(client, before.body)
  phase = 'CAPTURE_PUBLIC_ONLY'
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const entries: CaptureEntry[] = []
  let lastId = 0, complete = false
  for (let page = 0; page < 160; page++) {
    const rows = (await client.query(M1_PUBLIC_CAPTURE_SQL, [lastId, 128])).rows as CaptureRow[]
    if (!rows.length) { complete = true; break }
    for (const row of rows) {
      if (row.id <= lastId) throw new Error('M2_CAPTURE_PAGINATION_REQUIRED')
      const card = mapLiveProduct(row), detail = mapLiveProductDetail(row)
      // Explicit Public DTO only; raw rows, credentials and role metadata never enter assets.
      entries.push({ card, product: { ...card, publicContent: detail.publicContent, product_feature_values: detail.product_feature_values },
        listed: row.listing_eligible, searchable: row.search_eligible, priority: row.capture_priority, order: row.capture_sort_order })
      lastId = row.id
    }
  }
  if (!complete) throw new Error('M2_CAPTURE_CAPACITY')
  const categories = (await client.query(M1_PUBLIC_CATEGORY_CAPTURE_SQL)).rows as CaptureCategory[]
  const posts = mapPublicBlogRecords((await client.query(LIVE_BLOG)).rows)
  const blogCategories = (await client.query(PUBLIC_BLOG_CATEGORIES_SQL)).rows as LegacyBlogCategory[]
  if (entries.length !== access.products || entries.filter(e => e.listed).length !== access.listingProducts
    || posts.length !== access.publishedBlogs || posts.length !== 10
    || !entries.some(e => e.product.sku === 'A-LFV-402S-1')) throw new Error('M2_CAPTURE_PARITY_MISMATCH')
  await client.query('ROLLBACK')
  phase = 'ASSEMBLE_IMMUTABLE_PUBLIC_ASSETS'
  const capturedAt = new Date().toISOString()
  const snapshot = buildM2PublicSnapshot({ sourceSha: process.env.GITHUB_SHA!, productionSourceSha: before.sourceSha,
    capturedAt, entries, categories, posts, blogCategories })
  const after = await productionHealth()
  if (before.sourceSha !== after.sourceSha || JSON.stringify(before.body) !== JSON.stringify(after.body)) throw new Error('M2_PRODUCTION_CHANGED_DURING_CAPTURE')
  const output = resolve(process.env.RUNNER_TEMP!, 'm2-public-snapshot')
  await mkdir(output, { mode: 0o700 }) // Refuse replacing a previous capture.
  const catalogue = resolve(output, 'catalogue/v1')
  for (const file of snapshot.files) {
    const path = resolve(catalogue, file.name)
    if (!path.startsWith(catalogue + '/')) throw new Error('M2_CAPTURE_ASSET_PATH')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, file.body, { mode: 0o600, flag: 'wx' })
  }
  const evidence = { contract: 'dpg:m2-public-snapshot-lock:v1', checkpoint: snapshot.checkpoint,
    sourceSha: process.env.GITHUB_SHA, productionSourceSha: before.sourceSha, capturedAt, runId: process.env.GITHUB_RUN_ID,
    products: entries.length, listingProducts: entries.filter(e => e.listed).length, publishedBlogs: posts.length,
    sampleSku: 'A-LFV-402S-1', readOnly: true, tls: true, publicDataMutated: false,
    sqlSha256: createHash('sha256').update(M1_PUBLIC_CAPTURE_SQL + M1_PUBLIC_CATEGORY_CAPTURE_SQL + LIVE_BLOG + PUBLIC_BLOG_CATEGORIES_SQL).digest('hex'),
    files: snapshot.files.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })) }
  await writeFile(resolve(output, 'snapshot-lock.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ status: 'PASS', phase: 'M2_PUBLIC_CAPTURE', checkpoint: snapshot.checkpoint,
    sourceSha: process.env.GITHUB_SHA, productionSourceSha: before.sourceSha, capturedAt,
    products: entries.length, listingProducts: evidence.listingProducts, publishedBlogs: posts.length,
    assets: snapshot.files.length, bytes: snapshot.files.reduce((n, f) => n + f.bytes, 0), snapshotCreated: true }))
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : ''
  const allowed = new Set(['M2_SELECT_SECRET_MISSING','M2_SELECT_CA_MISSING','INVALID_CONNECTION','WRONG_PROJECT','CA_REQUIRED','ROLE_ATTRIBUTES','ROLE_TABLE_BOUNDARY','ROLE_TABLE_SET','ROLE_AUTHORITY_BOUNDARY','ROLE_SEQUENCE_BOUNDARY','M2_CAPTURE_PARITY_MISMATCH','M2_PRODUCTION_CHANGED_DURING_CAPTURE','M2_PUBLIC_ASSET_TOO_LARGE','M2_PUBLIC_SNAPSHOT_BUDGET'])
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  console.error(JSON.stringify({ status: 'STOP', phase, reason: allowed.has(message) ? message : 'M2_PROTECTED_CAPTURE_FAILED', ...(/^[0-9A-Z]{5}$/.test(code) ? { sqlState: code } : {}) }))
  process.exitCode = 1
}).finally(closeConnections)
