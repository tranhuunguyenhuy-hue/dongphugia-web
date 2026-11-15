import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('fixed staging survives source-driven Production publication', () => {
  it('preserves the reviewed main campaign Worker-first asset routes in fixed Preview', async () => {
    const production = JSON.parse(await readFile('apps/public/wrangler.production.jsonc', 'utf8'))
    const staging = JSON.parse(await readFile('apps/public/wrangler.fixed-preview.jsonc', 'utf8'))
    expect(staging.assets.run_worker_first).toEqual(production.assets.run_worker_first)
    expect(staging.assets.run_worker_first).toEqual(['/uudaicuoinam2026', '/uudaicuoinam2026/*'])
  })
  it('fails the existing Production identity gate if a packaged artifact would disable staging', async () => {
    const release = await readFile('.github/workflows/v1-worker-release.yml', 'utf8')
    expect(release).toContain('if(x.preview_urls!==true) process.exit(1)')
    expect(release).toContain('src.preview_urls=false;') // Only the temporary local/remote smoke config.
    expect(release).toContain('wrangler.public-preflight.json')
  })
  it.each(['postgresql', 'snapshot'])('keeps Preview URLs enabled through the existing %s configuration step', async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'm2-preview-persistence-'))
    try {
      const source = await readFile('apps/public/wrangler.production.jsonc', 'utf8')
      const config = join(directory, 'wrangler.json')
      await writeFile(config, source)
      execFileSync(process.execPath, ['scripts/app-foundation/configure-v1-m1-worker-source.mjs', config, mode, 'a'.repeat(32)])
      const prepared = JSON.parse(await readFile(config, 'utf8'))
      expect(prepared.preview_urls).toBe(true)
      expect(prepared.workers_dev).toBe(true)
      expect(prepared.name).toBe('dongphugia-v1-public-production')
      expect(prepared.vars.APP_ENV).toBe('production')
      expect(prepared.vars.PUBLIC_CATALOGUE_SOURCE).toBe(mode)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
