import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('fixed staging survives source-driven Production publication', () => {
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
