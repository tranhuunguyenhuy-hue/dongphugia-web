import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

/** Retry identity propagation only; HTTP/network/body failures remain failures. */
export async function waitPublicProductionIdentity(sha, {
  fetchImpl = fetch,
  now = Date.now,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  record = value => console.log(JSON.stringify(value)),
} = {}) {
  assert.match(sha ?? '', /^[a-f0-9]{40}$/)
  const started = now()
  while (true) {
    const elapsed = now() - started
    assert.ok(elapsed < 120000, 'PRODUCTION_IDENTITY_PROPAGATION_TIMEOUT')
    const response = await fetchImpl('https://www.dongphugia.vn/api/health', {
      signal: AbortSignal.timeout(Math.min(10000, 120000 - elapsed)),
      cache: 'no-store',
    })
    assert.equal(response.status, 200, 'PRODUCTION_IDENTITY_HTTP_FAILURE')
    const body = await response.json()
    const shaMatches = response.headers.get('x-dpg-source-sha') === sha
    const modeMatches = body.catalogueMode === 'postgresql'
    record({ event: 'PRODUCTION_IDENTITY_POLL', elapsedMs: now() - started, shaMatches, modeMatches })
    if (shaMatches && modeMatches) return
    const remaining = 120000 - (now() - started)
    assert.ok(remaining > 0, 'PRODUCTION_IDENTITY_PROPAGATION_TIMEOUT')
    await pause(Math.min(5000, remaining))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await waitPublicProductionIdentity(process.argv[2])
}
