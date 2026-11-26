// #510: fixed Staging lives inside the Production Worker, so a Staging publish must not run while a Production Worker release
// may be deploying. The guard reads the repository's unfinished runs (no per-workflow file-name lookup, so archiving a lane can
// never turn into "idle"), and any read error throws (fail closed).
//   - Production Release (m4-production-admin-release.yml) dispatched by hand: it may be a publish → busy. Its automatic
//     `workflow_run` verify is read-only and can never publish (#505 trigger gate) → not busy, so auto Staging + auto verify still
//     run in parallel after a merge.
//   - The archived Public-only lane (v1-worker-release.yml): any unfinished run still counts (it cannot start from main, but a
//     run that exists is reported, not ignored).
export const PRODUCTION_WORKER_RELEASE = '.github/workflows/m4-production-admin-release.yml'
export const LEGACY_PUBLIC_ONLY_RELEASE = '.github/workflows/v1-worker-release.yml'
export const UNFINISHED_STATUSES = Object.freeze(['queued', 'in_progress', 'waiting', 'requested', 'pending'])

/** Pure: the unfinished runs that block a Staging publish. */
export function busyProductionRuns(runs) {
  return (runs ?? []).filter((run) => run && run.status !== 'completed').filter((run) =>
    run.path === LEGACY_PUBLIC_ONLY_RELEASE || (run.path === PRODUCTION_WORKER_RELEASE && run.event !== 'workflow_run'))
}

/** `gh(path)` must throw on any non-OK response; a malformed answer also throws. */
export async function unfinishedRuns(gh) {
  const pages = await Promise.all(UNFINISHED_STATUSES.map((status) => gh(`actions/runs?status=${status}&per_page=100`)))
  return pages.flatMap((page) => {
    if (!Array.isArray(page?.workflow_runs)) throw new Error('PRODUCTION_RELEASE_STATE_UNKNOWN')
    return page.workflow_runs
  })
}

/** Throws `${prefix}_PRODUCTION_RELEASE_BUSY` (with sanitized evidence) when a Production Worker release may be running. */
export async function assertNoProductionWorkerRelease(gh, prefix, evidence = {}) {
  const busy = busyProductionRuns(await unfinishedRuns(gh))
  if (busy.length) {
    evidence.productionBusyRuns = busy.map(({ id, status, head_sha: sourceSha, path, event }) => ({ id, status, sourceSha, path, event }))
    throw new Error(`${prefix}_PRODUCTION_RELEASE_BUSY`)
  }
}
