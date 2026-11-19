// M4: turns the already assembled, verified Public Worker release (scripts/app-foundation/public-worker-artifact.mts) into
// the Production release that also carries the accepted Admin: static SPA under /admin-next, the Production dispatch
// (gateway + upload + legacy /admin redirect) as the Worker entry, the Images binding and the Admin variables. The Public
// bundle (`worker/index.js`) is NOT modified. Secrets are never written here: the publisher passes them with --secrets-file.
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { cp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runWranglerDryRun } from '../app-foundation/public-worker-artifact.mts'

const SOURCE_SHA = /^[0-9a-f]{40}$/
const PRODUCTION_WORKER = 'dongphugia-v1-public-production'
export const PRODUCTION_ORIGIN = 'https://www.dongphugia.vn'
export const PRODUCTION_ADMIN_API_URL = 'https://bonxyxluzlxfkdetryoo.supabase.co/functions/v1/admin-api'
export const PRODUCTION_MEDIA_CDN_HOST = 'cdn.dongphugia.com.vn'
const TEST_REF = 'uybumsnyqpwcidjxmfsv'
const INLINE_IMPORT = /^import .*\/\/ inline-import\r?\n/gm
const SECRET_ENVIRONMENT_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY)(?:_|$)|DATABASE_URL|DIRECT_URL|PRIVATE_KEY/i
const RUN_WORKER_FIRST = ['/uudaicuoinam2026', '/uudaicuoinam2026/*', '/admin-next', '/admin-next/', '/admin-next/api/*', '/admin', '/admin/*', '/api/upload-image']

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const run = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
  child.on('error', reject)
  child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`M4_BUILD_COMMAND_FAILED:${code}`)))
})

async function walk(root: string, relative = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name)
    if (entry.isSymbolicLink()) throw new Error('M4_ARTIFACT_SYMLINK_FORBIDDEN')
    if (entry.isDirectory()) files.push(...await walk(root, child)); else files.push(child)
  }
  return files
}

/** Production wrangler config derived from the verified Public release config. Pure: unit-tested. */
export function productionAdminConfig(base: Record<string, unknown>, media: { zone: string; storageHost: string }) {
  if (base.name !== PRODUCTION_WORKER) throw new Error('M4_WRONG_WORKER_TARGET')
  const vars = (base.vars ?? {}) as Record<string, string>
  if (vars.APP_ENV !== 'production' || vars.APP_BUILD_TARGET !== 'public' || vars.APP_ORIGIN !== PRODUCTION_ORIGIN || vars.PREVIEW_NOINDEX === 'true') throw new Error('M4_PRODUCTION_VARS_REQUIRED')
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(media.zone)) throw new Error('M4_MEDIA_ZONE_INVALID')
  if (!/^(?:[a-z]{2,3}\.)?storage\.bunnycdn\.com$/.test(media.storageHost)) throw new Error('M4_MEDIA_STORAGE_HOST_INVALID')
  const assets = { ...(base.assets as Record<string, unknown>), run_worker_first: RUN_WORKER_FIRST }
  return {
    ...base,
    main: 'worker/m4-entry.mjs',
    assets,
    images: { binding: 'IMAGES' },
    vars: {
      ...vars,
      ADMIN_API_URL: PRODUCTION_ADMIN_API_URL,
      BUNNY_STORAGE_ZONE_NAME: media.zone,
      BUNNY_STORAGE_HOSTNAME: media.storageHost,
      BUNNY_CDN_HOSTNAME: PRODUCTION_MEDIA_CDN_HOST,
    },
  }
}

export function composeProductionEntry(parts: { template: string; envelope: string; gateway: string; upload: string; dispatch: string; sourceSha: string }) {
  if (!SOURCE_SHA.test(parts.sourceSha)) throw new Error('M4_SOURCE_SHA_INVALID')
  const importLine = "import { createProductionAdminWorker } from './m4-production-dispatch.mjs'\n"
  if (!parts.template.includes(importLine) || !parts.template.includes("import('./index.js')") || !parts.template.includes('__M4_BUILD_SOURCE_SHA__')) throw new Error('M4_ENTRY_TEMPLATE_INVALID')
  const defaultExport = parts.template.slice(parts.template.indexOf('export default createProductionAdminWorker'))
  const templateBody = parts.template.replace(importLine, '').replace(defaultExport, '')
  const inlined = [parts.envelope, parts.gateway, parts.upload, parts.dispatch].map((source) => source.replace(INLINE_IMPORT, '').trim()).join('\n\n')
  if (/from '\.\.?\/[^']*(?:gateway|envelope|upload|dispatch)[^']*'/.test(inlined)) throw new Error('M4_INLINE_IMPORT_LEFT')
  return `${templateBody.trim()}\n\n${inlined}\n\n${defaultExport.replace('__M4_BUILD_SOURCE_SHA__', parts.sourceSha).trim()}\n`
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((pairs, token, index, all) => token.startsWith('--') ? [...pairs, [token.slice(2), all[index + 1] ?? '']] : pairs, []))
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const releaseDir = path.resolve(args['release-dir'] ?? '')
  const sourceSha = args['source-sha'] ?? ''
  if (!SOURCE_SHA.test(sourceSha)) throw new Error('M4_SOURCE_SHA_REQUIRED')
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim() !== sourceSha) throw new Error('M4_SOURCE_SHA_MISMATCH')
  if (Object.keys(process.env).some((name) => process.env[name] && SECRET_ENVIRONMENT_NAME.test(name) && !/^(?:GITHUB_TOKEN|ACTIONS_.*|RUNNER_.*)$/.test(name))) throw new Error('M4_BUILD_CREDENTIAL_ENV_FORBIDDEN')
  if (!await stat(path.join(releaseDir, 'worker/index.js')).then((entry) => entry.isFile()).catch(() => false)) throw new Error('M4_PUBLIC_RELEASE_REQUIRED')

  const base = JSON.parse(await readFile(path.join(releaseDir, 'wrangler.json'), 'utf8')) as Record<string, unknown>
  const config = productionAdminConfig(base, { zone: args['media-zone'] ?? '', storageHost: args['media-storage-host'] ?? '' })

  // Static Admin SPA, same Vite as staging, served under /admin-next by the assets binding.
  const spaRoot = path.join(repositoryRoot, 'apps/admin-spa')
  const target = path.join(releaseDir, 'assets/admin-next')
  if (await stat(target).then(() => true).catch(() => false)) throw new Error('M4_ADMIN_NEXT_ASSET_PATH_COLLISION')
  const buildEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false' }
  await run(process.execPath, [path.join(repositoryRoot, 'apps/public/node_modules/vite/bin/vite.js'), 'build'], spaRoot, buildEnv)
  await cp(path.join(spaRoot, 'dist'), target, { recursive: true })
  if (!await stat(path.join(target, 'index.html')).then((entry) => entry.isFile()).catch(() => false)) throw new Error('M4_ADMIN_NEXT_INDEX_REQUIRED')

  const read = (file: string) => readFile(path.join(repositoryRoot, file), 'utf8')
  const [template, envelope, gateway, upload, dispatch] = await Promise.all([
    read('apps/public/worker.m4-production.template.mjs'), read('apps/public/m3-admin-envelope.mjs'), read('apps/public/m3-admin-gateway.mjs'),
    read('apps/public/m4-admin-upload.mjs'), read('apps/public/m4-production-dispatch.mjs'),
  ])
  const entry = composeProductionEntry({ template, envelope, gateway, upload, dispatch, sourceSha })
  await writeFile(path.join(releaseDir, 'worker/m4-entry.mjs'), entry, 'utf8')
  await writeFile(path.join(releaseDir, 'wrangler.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')

  // No secret or Production function coordinates may ship in client assets or in the Public bundle.
  const forbidden = [/ADMIN_API_HMAC/, new RegExp(PRODUCTION_ADMIN_API_URL.split('//')[1]!.split('/')[0]!.replace(/\./g, '\\.')), /ADMIN_PRODUCTION_MEDIA_KEY/, new RegExp(TEST_REF)]
  for (const file of await walk(path.join(releaseDir, 'assets/admin-next'))) {
    const text = (await readFile(path.join(releaseDir, 'assets/admin-next', file))).toString('latin1')
    if (forbidden.some((pattern) => pattern.test(text))) throw new Error('M4_ADMIN_ASSET_LEAK')
  }
  const publicBundle = (await readFile(path.join(releaseDir, 'worker/index.js'))).toString('utf8')
  if (/ADMIN_API_HMAC|ADMIN_PRODUCTION_MEDIA_KEY/.test(publicBundle)) throw new Error('M4_PUBLIC_BUNDLE_LEAK')

  const dryRun = await runWranglerDryRun(repositoryRoot, releaseDir)
  if (dryRun.gzipKiB > 3 * 1024) throw new Error('M4_WORKER_FREE_GZIP_LIMIT_EXCEEDED')
  const evidence = {
    contract: 'dpg:m4-production-admin-worker:v1', sourceSha, workerName: PRODUCTION_WORKER, origin: PRODUCTION_ORIGIN,
    entrySha256: sha256(entry), publicBundleSha256: sha256(publicBundle), adminFiles: (await walk(path.join(releaseDir, 'assets/admin-next'))).length,
    wranglerGzipKiB: dryRun.gzipKiB, bindings: ['ASSETS', 'PUBLIC_DB', 'IMAGES'], secretsAtPublish: ['ADMIN_API_HMAC_SECRET', 'ADMIN_PRODUCTION_MEDIA_KEY(optional)'],
  }
  await writeFile(path.join(releaseDir, 'm4-admin-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ status: 'PASS', stage: 'M4_PRODUCTION_ADMIN_ARTIFACT', ...evidence })}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`M4_PRODUCTION_ADMIN_BUILD_FAILED:${error instanceof Error ? error.message : 'UNKNOWN'}\n`); process.exitCode = 1 })
}
