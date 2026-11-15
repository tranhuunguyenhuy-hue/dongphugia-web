import { cp, mkdir, readFile, writeFile, lstat, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { digestDirectory, runWranglerDryRun } from './public-worker-artifact.mjs'
import { FIXED_PREVIEW_NAME, FIXED_PREVIEW_ORIGIN, FIXED_PREVIEW_WORKER } from '../../apps/public/src/config/fixed-preview.mjs'

export async function verifyM2SnapshotLock(snapshotRoot: string, sourceSha: string) {
  const lock = JSON.parse(await readFile(join(snapshotRoot, 'snapshot-lock.json'), 'utf8'))
  if (lock.contract !== 'dpg:m2-public-snapshot-lock:v1' || lock.sourceSha !== sourceSha
    || !/^[a-f0-9]{40}$/.test(lock.checkpoint) || lock.readOnly !== true || lock.tls !== true
    || lock.publicDataMutated !== false || !Array.isArray(lock.files) || !lock.files.length || lock.files.length > 5000
    || lock.publishedBlogs !== 10 || lock.sampleSku !== 'A-LFV-402S-1') throw new Error('M2_SNAPSHOT_LOCK_REQUIRED')
  const catalogueRoot = join(snapshotRoot, 'catalogue/v1')
  if (!(await lstat(catalogueRoot)).isDirectory()) throw new Error('M2_SNAPSHOT_FILE_INVALID')
  const inventory: string[] = []
  async function visit(directory: string, relative = '') {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${item.name}` : item.name
      if (item.isDirectory()) await visit(join(directory, item.name), name)
      else if (item.isFile()) inventory.push(name)
      else throw new Error('M2_SNAPSHOT_FILE_INVALID')
    }
  }
  await visit(catalogueRoot)
  const seen = new Set<string>()
  let bytes = 0
  for (const file of lock.files) {
    if (typeof file.name !== 'string' || !/^(?:manifest|blog)\.json$|^(?:products\/[a-f0-9]{2}|search\/[0-3]|variants\/public-[1-9][0-9]*|listing-index\/[a-z0-9-]+\/[a-z0-9-]+|listings\/[a-z0-9-]+\/[a-z0-9-]+\/[1-9][0-9]*)\.json$/.test(file.name)
      || seen.has(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('M2_SNAPSHOT_FILE_INVALID')
    const path = join(snapshotRoot, 'catalogue/v1', file.name)
    if (!(await lstat(path)).isFile()) throw new Error('M2_SNAPSHOT_FILE_INVALID')
    const body = await readFile(path)
    if (body.length !== file.bytes || body.length > 2_000_000 || createHash('sha256').update(body).digest('hex') !== file.sha256) throw new Error('M2_SNAPSHOT_HASH_MISMATCH')
    const value = JSON.parse(new TextDecoder().decode(body))
    if (value.contract !== 'dpg:public-catalogue-snapshot:v1' || value.checkpoint !== lock.checkpoint) throw new Error('M2_SNAPSHOT_CHECKPOINT_MISMATCH')
    seen.add(file.name); bytes += body.length
  }
  if (inventory.length !== seen.size || inventory.some(name => !seen.has(name))) throw new Error('M2_SNAPSHOT_UNDECLARED_FILE')
  if (!seen.has('manifest.json') || !seen.has('blog.json') || bytes > 100_000_000) throw new Error('M2_SNAPSHOT_CAPACITY')
  const manifest = JSON.parse(await readFile(join(snapshotRoot, 'catalogue/v1/manifest.json'), 'utf8'))
  if (manifest.captureSource !== 'm1-public-read-model' || manifest.sourceSha !== sourceSha
    || manifest.productionSourceSha !== lock.productionSourceSha || manifest.products !== lock.products
    || manifest.listingProducts !== lock.listingProducts || manifest.publishedBlogs !== 10) throw new Error('M2_SNAPSHOT_MANIFEST_MISMATCH')
  return lock
}

async function main() {
  const args = process.argv.slice(2)
  const get = (name: string) => args[args.indexOf(name) + 1]
  const sourceSha = get('--source-sha')
  if (!/^[a-f0-9]{40}$/.test(sourceSha || '') || !args.includes('--snapshot-dir') || !args.includes('--output')) throw new Error('M2_ASSEMBLY_ARGUMENTS')
  const snapshotRoot = resolve(get('--snapshot-dir')), output = resolve(get('--output'))
  const lock = await verifyM2SnapshotLock(snapshotRoot, sourceSha)
  const repo = process.cwd(), server = join(repo, 'apps/public/dist/server')
  const generated = JSON.parse(await readFile(join(server, 'wrangler.json'), 'utf8'))
  if (generated.vars?.APP_ENV !== 'staging' || generated.vars?.APP_ORIGIN !== FIXED_PREVIEW_ORIGIN
    || generated.vars?.PREVIEW_NOINDEX !== 'true' || generated.vars?.PUBLIC_CATALOGUE_SOURCE !== 'snapshot'
    || generated.hyperdrive?.length || generated.services?.length || generated.durable_objects?.bindings?.length) throw new Error('M2_BUILD_ISOLATION_REQUIRED')
  await mkdir(output, { mode: 0o700 })
  await cp(server, join(output, 'worker'), { recursive: true, filter: path => !['wrangler.json', '.wrangler'].includes(path.split('/').at(-1)!) })
  await cp(join(repo, 'apps/public/dist/client'), join(output, 'assets'), { recursive: true, filter: path => path.split('/').at(-1) !== '__catalogue' })
  await cp(join(snapshotRoot, 'catalogue/v1'), join(output, 'assets/__catalogue/v1'), { recursive: true, errorOnExist: true, force: false })
  const vars = { APP_ENV: 'staging', APP_BUILD_TARGET: 'public', APP_ORIGIN: FIXED_PREVIEW_ORIGIN,
    PREVIEW_NOINDEX: 'true', PUBLIC_CATALOGUE_SOURCE: 'snapshot', PUBLIC_CATALOGUE_CHECKPOINT: lock.checkpoint }
  const config = { name: FIXED_PREVIEW_WORKER, compatibility_date: '2026-08-30', compatibility_flags: ['nodejs_compat'],
    main: 'worker/index.js', workers_dev: true, preview_urls: true, no_bundle: true,
    rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }], assets: { directory: 'assets', binding: 'ASSETS', not_found_handling: 'none' },
    vars, previews: { vars, secrets: { required: [] }, hyperdrive: [], services: [], durable_objects: { bindings: [] } } }
  const text = JSON.stringify(config, null, 2) + '\n'
  await writeFile(join(output, 'wrangler.fixed-preview.json'), text, { mode: 0o600 })
  await writeFile(join(output, 'snapshot-lock.json'), JSON.stringify(lock, null, 2) + '\n', { mode: 0o600 })
  const dryRun = await runWranglerDryRun(repo, output, 'wrangler.fixed-preview.json', join(repo, 'tools/m2-preview/node_modules/wrangler/bin/wrangler.js'))
  const worker = await digestDirectory(join(output, 'worker')), assets = await digestDirectory(join(output, 'assets'))
  if (dryRun.gzipKiB > 3 * 1024 || assets.fileCount > 20_000 || assets.largestFile.bytes > 25 * 1024 * 1024) throw new Error('M2_EXISTING_RESOURCE_BUDGET')
  const evidence = { contract: 'dpg:m2-fixed-preview-artifact:v1', workerName: FIXED_PREVIEW_WORKER, previewName: FIXED_PREVIEW_NAME,
    sourceSha, checkpoint: lock.checkpoint, productionSourceSha: lock.productionSourceSha, snapshotCapturedAt: lock.capturedAt,
    configSha256: createHash('sha256').update(text).digest('hex'), worker, assets, dryRun, publisherWrangler: '4.135.0' }
  await writeFile(join(output, 'm2-artifact.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ status: 'PASS', stage: 'M2_ARTIFACT', ...evidence }))
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) main().catch(() => {
  console.error(JSON.stringify({ status: 'STOP', stage: 'M2_ASSEMBLY', reason: 'ARTIFACT_VALIDATION_FAILED' })); process.exitCode = 1
})
