import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { navigationTarget, readM2AccessHeaders, applyM2BrowserAccess } from './m2-navigation-context.mjs'
import { sanitizeM2CommandFailure } from './m2-public-diagnostics.mjs'
import { validateM2PreviewConfig } from './publish-m2-fixed-preview.mjs'
import { readFile } from 'node:fs/promises'
const origin = 'https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev'
const checkpoint = 'a'.repeat(40)

describe('M2 publisher safety boundaries', () => {
  it('allows only localhost or this Worker Preview and cannot use M2 mode to bypass Production checks', () => {
    expect(navigationTarget(origin, { M2_PUBLIC_SNAPSHOT_CHECKPOINT: checkpoint }).hosted).toBe(true)
    expect(() => navigationTarget('https://www.dongphugia.vn', { M2_PUBLIC_SNAPSHOT_CHECKPOINT: checkpoint })).toThrow('M2_PREVIEW_ORIGIN_REQUIRED')
    expect(() => navigationTarget('https://other.workers.dev', { M2_PUBLIC_SNAPSHOT_CHECKPOINT: checkpoint })).toThrow()
    expect(() => navigationTarget(origin, {})).toThrow('M1_ORIGIN_REQUIRED')
  })
  it('reads CI credentials only from a private file and forwards them only to the exact Preview origin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'm2-access-test-'))
    try {
      const file = join(directory, 'access.json')
      await writeFile(file, JSON.stringify({ client_id: 'synthetic-id', client_secret: 'synthetic-secret' }), { mode: 0o600 })
      const headers = readM2AccessHeaders(origin, file)
      expect(() => readM2AccessHeaders('https://www.dongphugia.vn', file)).toThrow()
      let handler: (route: unknown) => Promise<void> = async () => {}
      await applyM2BrowserAccess({ route: async (_pattern: string, callback: typeof handler) => { handler = callback } }, origin, headers)
      for (const target of [origin + '/api/search', 'https://dpg-products.b-cdn.net/image.jpg', 'https://www.dongphugia.vn/']) {
        const next = vi.fn()
        await handler({ request: () => ({ url: () => target, headers: () => ({ 'cf-access-client-secret': 'previous' }) }), continue: next })
        const actual = next.mock.calls[0][0].headers
        expect(actual['CF-Access-Client-Secret']).toBe(target.startsWith(origin + '/') ? 'synthetic-secret' : undefined)
        expect(actual['cf-access-client-secret']).toBeUndefined()
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('rejects DB bindings, arbitrary Preview destinations and privileged vars', async () => {
    const template = JSON.parse(await readFile('apps/public/wrangler.fixed-preview.jsonc', 'utf8'))
    const meta = { workerName: template.name, previewName: 'staging', checkpoint }
    const config = { ...template, main: 'worker/index.js', no_bundle: true, assets: { directory: 'assets', binding: 'ASSETS', not_found_handling: 'none' } }
    delete config.$schema // Packaged config is rebuilt from a closed field allowlist.
    config.vars.PUBLIC_CATALOGUE_CHECKPOINT = checkpoint; config.previews.vars.PUBLIC_CATALOGUE_CHECKPOINT = checkpoint
    expect(() => validateM2PreviewConfig(config, meta)).not.toThrow()
    expect(() => validateM2PreviewConfig({ ...config, hyperdrive: [{ binding: 'PUBLIC_DB', id: 'a'.repeat(32) }] }, meta)).toThrow()
    expect(() => validateM2PreviewConfig({ ...config, vars: { ...config.vars, DATABASE_URL: 'synthetic' } }, meta)).toThrow()
    expect(() => validateM2PreviewConfig({ ...config, name: 'dpg-staging' }, meta)).toThrow()
  })
  it('preserves route failures while dropping secret headers, tokens and signed URL queries', () => {
    const safe = sanitizeM2CommandFailure('HTTP 503 /blog/article\nAuthorization: Bearer private-key\nCF-Access-Client-Secret: private-key\nhttps://public.example/image?signature=private-key\nvalue private-key', ['private-key'])
    expect(safe).toContain('HTTP 503 /blog/article')
    expect(safe).not.toContain('private-key')
    expect(safe).not.toContain('signature=')
    expect(safe).not.toContain('Bearer')
  })
})
