import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const template = readFileSync('apps/public/worker.m3-combined.template.mjs', 'utf8')
const builder = readFileSync('scripts/app-foundation/build-m3-combined-admin.mts', 'utf8')

describe('M3 combined Worker entrypoint', () => {
  it('loads the Public and Admin server bundles lazily, never at Worker startup', () => {
    expect(template).toContain("import('./public/server/index.js')")
    expect(template).toContain("import('./admin/server/index.mjs')")
    expect(template).not.toMatch(/^import\s+\w+\s+from\s+'\.\/(public|admin)\/server/m)
  })

  it('the builder requires the lazy form and rejects static server imports', () => {
    expect(builder).toContain('FORBIDDEN_STATIC_SERVER_IMPORTS')
    expect(builder).toContain("import('./public/server/index.js')")
  })

  it('does not cache a failed bundle load', async () => {
    // lazyWorker retries after a rejected import instead of pinning the rejection for the isolate lifetime.
    expect(template).toContain('loading = null; throw error')
  })
})
