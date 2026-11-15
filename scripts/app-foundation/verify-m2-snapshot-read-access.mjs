// Protected runner only. Reuse the existing V1 SELECT connection and its TLS,
// target and privilege attestation. No credential is copied into a Preview.
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function verifyM2SnapshotReadAccess(client, production) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    const identity = (await client.query("SELECT current_user AS role, current_setting('transaction_read_only') AS read_only, (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls")).rows[0]
    if (!identity || identity.read_only !== 'on' || identity.tls !== true) throw new Error('READ_ONLY_TLS_REQUIRED')
    // Same visibility predicates as the existing M1 public-db preflight.
    const from = `FROM dpg_app.products p
      JOIN dpg_app.categories c ON c.id=p.category_id AND c.is_active=true
      JOIN dpg_app.subcategories s ON s.id=p.subcategory_id AND s.category_id=c.id AND s.is_active=true`
    const visible = `p.is_active=true AND p.publication_status='public' AND p.pdp_visibility='public'
      AND p.id>0 AND p.name<>'' AND char_length(p.name)<=240 AND p.sku<>'' AND char_length(p.sku)<=120
      AND p.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND c.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
      AND s.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`
    const counts = (await client.query(`SELECT
      (SELECT count(*) ${from} WHERE ${visible})::int AS products,
      (SELECT count(*) ${from} WHERE ${visible} AND p.listing_visibility IN ('default','low_priority'))::int AS listings,
      (SELECT count(*) FROM dpg_app.blog_posts p JOIN dpg_app.blog_categories c ON c.id=p.category_id
        WHERE p.status='published' AND p.published_at IS NOT NULL AND c.is_active=true)::int AS blogs,
      EXISTS(SELECT 1 ${from} WHERE ${visible} AND p.sku=$1) AS sample_present`, ['A-LFV-402S-1'])).rows[0]
    if (counts?.products !== production.publicProducts || counts.listings !== production.listingProducts
      || counts.blogs !== production.publishedBlogs || !counts.sample_present) throw new Error('PRODUCTION_SQL_COUNTS_MISMATCH')
    await client.query('ROLLBACK')
    return { contract: 'dpg:m2-snapshot-read-access:v1', status: 'PASS', role: identity.role,
      readOnly: true, tls: true, products: counts.products, listingProducts: counts.listings,
      publishedBlogs: counts.blogs, sampleSku: 'A-LFV-402S-1', snapshotCreated: false }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main'
    || process.env.GITHUB_REPOSITORY !== 'tranhuunguyenhuy-hue/dongphugia.com.vn'
    || process.env.GITHUB_ACTOR !== 'tranhuunguyenhuy-hue'
    || process.env.GITHUB_WORKFLOW_REF !== 'tranhuunguyenhuy-hue/dongphugia.com.vn/.github/workflows/v1-fixed-preview.yml@refs/heads/main'
    || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '')) throw new Error('PROTECTED_RUNNER_REQUIRED')
  const response = await fetch('https://www.dongphugia.vn/api/health', { signal: AbortSignal.timeout(15000), redirect: 'error' })
  const productionSource = response.headers.get('x-dpg-source-sha')
  if (!response.ok || !/^[a-f0-9]{40}$/.test(productionSource || '')) throw new Error('PRODUCTION_IDENTITY_REQUIRED')
  const production = await response.json()
  if (production.status !== 'ok' || production.catalogueMode !== 'postgresql'
    || ![production.publicProducts, production.listingProducts, production.publishedBlogs].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('PRODUCTION_HEALTH_REQUIRED')
  const { connect, closeConnections } = await import('../catalogue-direct/run.mjs')
  try {
    const client = await connect('read')
    const evidence = { ...await verifyM2SnapshotReadAccess(client, production), sourceSha: process.env.GITHUB_SHA,
      productionSourceSha: productionSource, verifiedAt: new Date().toISOString(), publicDataMutated: false }
    const output = resolve(process.env.RUNNER_TEMP, 'm2-read-access')
    await mkdir(output, { recursive: true, mode: 0o700 })
    await writeFile(resolve(output, 'read-access.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
    console.log(JSON.stringify(evidence))
  } finally {
    await closeConnections()
  }
}

if (process.argv[1]?.endsWith('/verify-m2-snapshot-read-access.mjs')) {
  main().catch(() => {
    // pg errors may contain URLs, rows or credentials: emit no original error.
    console.error(JSON.stringify({ status: 'STOP', stage: 'M2_READ_ACCESS', reason: 'PROTECTED_READ_ACCESS_FAILED', snapshotCreated: false }))
    process.exitCode = 1
  })
}
