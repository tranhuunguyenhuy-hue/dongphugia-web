// #510: the Staging publishers' "Production busy" guard after the Public-only lane was archived.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LEGACY_PUBLIC_ONLY_RELEASE, PRODUCTION_WORKER_RELEASE, assertNoProductionWorkerRelease, busyProductionRuns } from './production-release-busy.mjs'

const run = (path, status, event = 'workflow_dispatch', id = 1) => ({ id, path, status, event, head_sha: 'a'.repeat(40) })
const ghWith = (runs) => async (path) => {
  const status = new URL(`https://x/${path}`).searchParams.get('status')
  return { workflow_runs: runs.filter((r) => r.status === status) }
}

describe('#510 Staging publish guard: Production Worker release busy', () => {
  it('a hand-dispatched Production Release run (possibly a publish) is busy, in every unfinished status', async () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
      const evidence = {}
      await expect(assertNoProductionWorkerRelease(ghWith([run(PRODUCTION_WORKER_RELEASE, status)]), 'M3', evidence)).rejects.toThrow('M3_PRODUCTION_RELEASE_BUSY')
      expect(evidence.productionBusyRuns).toEqual([{ id: 1, status, sourceSha: 'a'.repeat(40), path: PRODUCTION_WORKER_RELEASE, event: 'workflow_dispatch' }])
    }
  })

  it('an unfinished run of the archived Public-only lane is still detected (archived path, no file-name lookup)', async () => {
    await expect(assertNoProductionWorkerRelease(ghWith([run(LEGACY_PUBLIC_ONLY_RELEASE, 'in_progress')]), 'M2')).rejects.toThrow('M2_PRODUCTION_RELEASE_BUSY')
  })

  it('the automatic read-only verify, other workflows and finished runs do not block', async () => {
    expect(busyProductionRuns([run(PRODUCTION_WORKER_RELEASE, 'in_progress', 'workflow_run'), run('.github/workflows/quality.yml', 'in_progress'),
      run(PRODUCTION_WORKER_RELEASE, 'completed'), run(LEGACY_PUBLIC_ONLY_RELEASE, 'completed')])).toEqual([])
    await expect(assertNoProductionWorkerRelease(ghWith([]), 'M3')).resolves.toBeUndefined()
  })

  it('fails closed on an API error (including 404) or a malformed answer', async () => {
    await expect(assertNoProductionWorkerRelease(async () => { throw new Error('M3_GITHUB_READ_REQUIRED') }, 'M3')).rejects.toThrow('M3_GITHUB_READ_REQUIRED')
    await expect(assertNoProductionWorkerRelease(async () => ({ message: 'Not Found' }), 'M3')).rejects.toThrow('PRODUCTION_RELEASE_STATE_UNKNOWN')
  })

  it('both Staging publishers use the shared guard and no longer query the archived workflow by file name', () => {
    for (const file of ['publish-m2-fixed-preview.mjs', 'publish-m3-fixed-preview.mjs']) {
      const source = readFileSync(`scripts/app-foundation/${file}`, 'utf8')
      expect(source).toContain('assertNoProductionWorkerRelease(gh,')
      expect(source).not.toContain('actions/workflows/v1-worker-release.yml')
    }
  })
})
