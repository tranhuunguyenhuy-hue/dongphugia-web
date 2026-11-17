import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const publisher = readFileSync('scripts/app-foundation/publish-m3-fixed-preview.mjs', 'utf8')
const workflow = readFileSync('.github/workflows/v1-fixed-preview.yml', 'utf8')
const m3Jobs = workflow.slice(workflow.indexOf('  prepare-m3:'))

describe('M3 fixed Preview publisher gates', () => {
  it('pins main, owner actor, repository, workflow ref and exact SHA', () => {
    for (const gate of [
      "GITHUB_REF, 'refs/heads/main'",
      "GITHUB_ACTOR, 'tranhuunguyenhuy-hue'",
      "GITHUB_REPOSITORY, 'tranhuunguyenhuy-hue/dongphugia.com.vn'",
      '.github/workflows/v1-fixed-preview.yml@refs/heads/main',
      'assert.equal(sourceSha, process.env.GITHUB_SHA)',
      "M3_MAIN_ADVANCED",
    ]) expect(publisher, gate).toContain(gate)
  })

  it('publishes only to the named Preview and never runs a Production deploy', () => {
    expect(publisher).toContain("'preview', '--worker-name', FIXED_PREVIEW_WORKER, '--name', FIXED_PREVIEW_NAME")
    expect(publisher).toContain('--ignore-base-config')
    expect(publisher).not.toMatch(/['"]deploy['"]/)
    expect(m3Jobs).not.toMatch(/wrangler(?:\.js)?\s+deploy/)
  })

  it('rejects Production Hyperdrive reuse and verifies Production is unchanged', () => {
    expect(publisher).toContain('M3_PRODUCTION_HYPERDRIVE_REUSE_FORBIDDEN')
    expect(publisher).toContain('ensureProductionUnchanged')
    expect(publisher).toContain('M3_PRODUCTION_CHANGED_STOP')
  })

  it('keeps secrets out of the artifact and out of build jobs', () => {
    expect(m3Jobs.split('publish-m3:')[0]).not.toContain('secrets.')
    expect(m3Jobs).toContain('M3_PREVIEW_BUNNY_STORAGE_API_KEY: ${{ secrets.M3_PREVIEW_BUNNY_STORAGE_API_KEY }}')
    expect(publisher).toContain("mode: 0o600, flag: 'wx'")
  })

  it('does not widen the M2 jobs or use the Production release workflow', () => {
    expect(workflow).toContain("!endsWith(inputs.operation, '-m3')")
    expect(m3Jobs).not.toContain('v1-worker-release')
  })
})
