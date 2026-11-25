// #505 Lean Release Pipeline: unit tests and negative gates (pure functions, no network).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { diffFlags, flagsDigest, flagsFromBindings, formatFlagsChange, loadFlags, parseFlags } from './flags.mjs'
import { evaluateGo, isVerifyOperation, parseDirectives, stagingAt } from './go-evidence.mjs'
import { activeVersionId, isCombinedStagingIdentity, plainLines, qualityFromRuns } from './lib.mjs'
import { readiness, renderEvidence } from './release-evidence.mjs'
import { classifyLane, fullCategory, laneForPath, legacyFunctionBlock } from './risk-lane.mjs'
import { evaluateLock, lockedSha } from './staging-lock.mjs'
import { evaluateTrigger } from './trigger-gate.mjs'

const REPO = 'tranhuunguyenhuy-hue/dongphugia-web'
const OWNER = 'tranhuunguyenhuy-hue'
const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40)
const live = JSON.parse(readFileSync('scripts/release/fixtures/production-version-298c38ba.json', 'utf8'))
const flagsText = (over = {}) => JSON.stringify({ schema: 1, canonical_pricing: 'on', canonical_brands: 'toto,inax', commerce: 'on', series_variant: 'off', ...over })

describe('#505 D2 flags-as-code', () => {
  it('bootstraps the reviewed file from the verified live Production version (no change)', () => {
    const file = loadFlags('release/production-flags.json')
    expect(file).toEqual({ canonical_pricing: 'on', canonical_brands: 'toto,inax', commerce: 'on', series_variant: 'off' })
    expect(diffFlags(file, flagsFromBindings(live.resources.bindings))).toEqual([])
    expect(flagsDigest(file)).toMatch(/^[0-9a-f]{12}$/)
  })

  it('rejects missing, extra, defaulted or unknown values (strict schema, no fallback)', () => {
    for (const bad of [
      '{}', 'not json', '[]',
      JSON.stringify({ schema: 1, canonical_pricing: 'on', canonical_brands: 'toto,inax', series_variant: 'off' }),
      flagsText({ extra: 'x' }), flagsText({ schema: 2 }), flagsText({ canonical_pricing: 'true' }), flagsText({ commerce: true }),
      flagsText({ canonical_brands: 'toto,caesar' }), flagsText({ canonical_pricing: 'off' }),
      flagsText({ series_variant: 'on' }), flagsText({ commerce: '' }),
    ]) expect(() => parseFlags(bad), bad).toThrow()
    expect(parseFlags(flagsText({ canonical_pricing: 'off', canonical_brands: '' })).canonical_pricing).toBe('off')
  })

  it('treats inconsistent live bindings as UNKNOWN (fail closed) and reports intentional changes exactly', () => {
    const without = (name) => live.resources.bindings.filter((b) => b.name !== name)
    expect(() => flagsFromBindings(without('ORDER_INTAKE_DB'))).toThrow(/commerce/)
    expect(() => flagsFromBindings(without('PUBLIC_CANONICAL_PRICE_BRANDS'))).toThrow(/canonical_pricing/)
    expect(() => flagsFromBindings([...live.resources.bindings, { name: 'PUBLIC_SERIES_VARIANT', type: 'plain_text', text: 'maybe' }])).toThrow()
    expect(formatFlagsChange(diffFlags(parseFlags(flagsText({ commerce: 'off' })), flagsFromBindings(live.resources.bindings)))).toBe('commerce=off')
    const pricingOff = parseFlags(flagsText({ canonical_pricing: 'off', canonical_brands: '' }))
    expect(formatFlagsChange(diffFlags(pricingOff, flagsFromBindings(live.resources.bindings)))).toBe('canonical_pricing=off;canonical_brands=-')
  })

  it('reads exactly one active version and refuses split traffic or an empty deployment list', () => {
    expect(activeVersionId({ deployments: [{ created_on: '2026-11-25T13:28:30Z', versions: [{ version_id: live.id, percentage: 100 }] }] })).toBe(live.id)
    expect(() => activeVersionId({ deployments: [] })).toThrow()
    expect(() => activeVersionId({ deployments: [{ created_on: 'x', versions: [{ version_id: live.id, percentage: 50 }, { version_id: live.id, percentage: 50 }] }] })).toThrow()
  })
})

describe('#505 risk lane floor and full categories', () => {
  it.each([
    ['docs/ops/v1-fast-release.md', 'none'], ['scripts/release/release.test.mjs', 'none'],
    ['supabase/functions/admin-api/production-migration.test.ts', 'none'],
    ['src/app/globals.css', 'fast'], ['public/banners/home.webp', 'fast'],
    ['src/components/layout/header.tsx', 'standard'], ['src/components/blog/author-card.tsx', 'standard'],
    ['src/components/cart/CartDrawer.tsx', 'extended'], ['src/app/(public)/gio-hang/page.tsx', 'extended'],
    ['src/lib/canonical-price.ts', 'extended'], ['apps/public/worker.ts', 'extended'], ['release/production-flags.json', 'extended'],
    ['apps/admin-spa/src/Sales.tsx', 'extended'], ['unknown/thing.txt', 'extended'],
    // Pipeline-only: never a hosted DB/function/binding change, so it can not block Worker-only releases forever (#509 itself).
    ['.github/workflows/quality.yml', 'extended'], ['scripts/release/go-evidence.mjs', 'extended'], ['scripts/backup/b11_rewrap_core.py', 'extended'],
    ['prisma/schema.prisma', 'full'], ['supabase/migrations/0001.sql', 'full'], ['supabase/functions/admin-api/index.ts', 'full'],
    ['scripts/m6/allowlist.json', 'full'], ['apps/public/wrangler.production.jsonc', 'full'],
  ])('%s → %s', (path, lane) => expect(laneForPath(path)).toBe(lane))

  it('names the full category per path and keeps the highest lane of a change set', () => {
    expect(['supabase/migrations/1.sql', 'supabase/functions/x/index.ts', 'apps/public/wrangler.jsonc', 'src/a.tsx'].map(fullCategory))
      .toEqual(['sql', 'function', 'bindings', null])
    expect(classifyLane(['docs/a.md', 'src/app/globals.css']).lane).toBe('fast')
    const mixed = classifyLane(['src/components/x.tsx', 'supabase/migrations/2.sql'])
    expect(mixed).toMatchObject({ lane: 'full', categories: { sql: ['supabase/migrations/2.sql'] } })
    expect(classifyLane([]).lane).toBe('none')
  })

  it('#511 refuses a legacy (plan-less) Production function deploy when the release changes a function or its scope is unknown', () => {
    expect(legacyFunctionBlock(classifyLane(['src/components/x.tsx']))).toBeNull()
    expect(legacyFunctionBlock(classifyLane(['supabase/functions/admin-api/index.ts']))).toMatch(/^FUNCTION_CHANGE_REQUIRES_PLAN files=1/)
    expect(legacyFunctionBlock({ unknown: true, categories: {} })).toMatch(/^RELEASE_SCOPE_UNKNOWN/)
    expect(legacyFunctionBlock(undefined)).toMatch(/^RELEASE_SCOPE_UNKNOWN/)
  })
})

const base = { target: 'm4', repo: REPO, ref: 'refs/heads/main', actor: OWNER, githubSha: A, mainHead: A }
const wr = { path: '.github/workflows/quality.yml', event: 'push', headBranch: 'main', headRepo: REPO, conclusion: 'success', actor: OWNER, headSha: A }
const free = { allowed: true, reason: 'LOCK_FREE' }
const qOk = { state: 'success' }

describe('#505 D1 trigger gate', () => {
  it('auto-preflight: trusted main push yields verify only (auto publish impossible)', () => {
    expect(evaluateTrigger({ ...base, event: 'workflow_run', workflowRun: wr, scopeLane: 'standard' })).toMatchObject({ run: true, mode: 'auto', operation: 'verify', sha: A })
    expect(evaluateTrigger({ ...base, target: 'staging', event: 'workflow_run', workflowRun: wr, scopeLane: 'extended', lock: free }))
      .toMatchObject({ run: true, mode: 'auto', operation: 'publish-m3' })
  })

  it.each([
    ['PR quality run', { event: 'pull_request' }], ['fork head', { headRepo: 'evil/dongphugia-web' }],
    ['non-main branch', { headBranch: 'feature' }], ['failed quality', { conclusion: 'failure' }],
    ['other workflow', { path: '.github/workflows/homepage-quality.yml' }], ['other actor', { actor: 'someone' }],
    ['superseded head', { headSha: B }],
  ])('auto-preflight skips untrusted/stale trigger: %s', (_name, over) => {
    expect(evaluateTrigger({ ...base, event: 'workflow_run', workflowRun: { ...wr, ...over }, scopeLane: 'standard' })).toMatchObject({ run: false, fail: false })
  })

  it('decides on the CUMULATIVE scope: a pending full change or unknown scope never auto-publishes Staging; verify stays read-only', () => {
    // e.g. an unreleased SQL change merged earlier, then a UI merge: cumulative lane is full → combined Staging waits for the plan.
    for (const scopeLane of ['full', undefined]) {
      expect(evaluateTrigger({ ...base, target: 'staging', event: 'workflow_run', workflowRun: wr, scopeLane, lock: free }))
        .toMatchObject({ run: false, fail: false, reason: 'FULL_LANE_OR_UNKNOWN_SCOPE_RUNS_BY_PLAN' })
      // #511: the M4 verify (read-only, never publish) still runs and shows if the new Worker fits the current Production schema.
      expect(evaluateTrigger({ ...base, event: 'workflow_run', workflowRun: wr, scopeLane })).toMatchObject({ run: true, mode: 'auto', operation: 'verify' })
    }
    expect(evaluateTrigger({ ...base, event: 'workflow_run', workflowRun: wr, scopeLane: 'none' }).reason).toBe('NO_RUNTIME_CHANGE_VS_PRODUCTION')
    expect(evaluateTrigger({ ...base, event: 'workflow_run', workflowRun: wr, mainHead: B, scopeLane: 'standard' }).reason).toMatch(/SUPERSEDED/)
    const locked = { allowed: false, reason: 'STAGING_UAT_LOCKED issue=#499 sha=x' }
    expect(evaluateTrigger({ ...base, target: 'staging', event: 'workflow_run', workflowRun: wr, scopeLane: 'standard', lock: locked }))
      .toMatchObject({ run: false, fail: false, reason: locked.reason })
  })

  it('manual dispatch keeps the identity rules and refuses misuse loudly', () => {
    expect(evaluateTrigger({ ...base, event: 'workflow_dispatch', quality: qOk, input: { sha: A, operation: 'publish' } })).toMatchObject({ run: true, mode: 'manual', operation: 'publish' })
    for (const [over, reason] of [
      [{ input: { sha: B, operation: 'verify' } }, 'APPROVED_SHA_NOT_DISPATCHED_MAIN'],
      [{ input: { sha: A, operation: 'verify' }, ref: 'refs/heads/claude/x' }, 'REF_NOT_MAIN'],
      [{ input: { sha: A, operation: 'verify' }, actor: 'someone' }, 'ACTOR_NOT_ALLOWED'],
      [{ input: { sha: A, operation: 'verify' }, repo: 'evil/repo' }, 'REPOSITORY_NOT_ALLOWED'],
      [{ input: { sha: A, operation: 'verify' }, mainHead: B }, 'SUPERSEDED main=' + B],
      [{ input: { sha: A, operation: 'deploy' } }, 'OPERATION_INVALID'],
      [{ event: 'push', input: {} }, 'EVENT_NOT_ALLOWED'],
    ]) expect(evaluateTrigger({ ...base, event: 'workflow_dispatch', quality: qOk, ...over })).toMatchObject({ run: false, fail: true, reason })
  })

  it.each(['failure', 'missing', 'pending', 'unknown'])('manual verify/publish/Staging is refused when quality on main is %s (no CI bypass)', (state) => {
    for (const [target, operation] of [['m4', 'verify'], ['m4', 'publish'], ['staging', 'publish-m3'], ['staging', 'lock-uat'], ['staging', 'prepare-m3']]) {
      expect(evaluateTrigger({ ...base, target, event: 'workflow_dispatch', quality: { state }, lock: free, input: { sha: A, operation, uatIssue: '7' } }))
        .toMatchObject({ run: false, fail: true, reason: `QUALITY_NOT_PASSED state=${state}` })
    }
    expect(evaluateTrigger({ ...base, event: 'workflow_dispatch', input: { sha: A, operation: 'verify' } }).reason).toBe('QUALITY_NOT_PASSED state=UNKNOWN')
  })

  it('reads the latest trusted quality push run on main for the exact SHA', () => {
    const q = (id, created_at, status, conclusion, over = {}) => ({ id, created_at, status, conclusion, path: '.github/workflows/quality.yml', event: 'push',
      head_branch: 'main', head_sha: A, head_repository: { full_name: REPO }, ...over })
    expect(qualityFromRuns([q(1, 't1', 'completed', 'success')], A)).toMatchObject({ state: 'success' })
    expect(qualityFromRuns([q(1, 't1', 'completed', 'success'), q(2, 't2', 'completed', 'failure')], A).state).toBe('failure') // re-run failed
    expect(qualityFromRuns([q(1, 't1', 'completed', 'success'), q(2, 't2', 'in_progress', null)], A).state).toBe('pending')
    expect(qualityFromRuns([q(1, 't1', 'completed', 'success', { event: 'pull_request' })], A).state).toBe('missing')
    expect(qualityFromRuns([q(1, 't1', 'completed', 'success', { head_repository: { full_name: 'evil/x' } })], A).state).toBe('missing')
  })

  it('every Staging writer is refused while the lock does not allow it; the legacy M2 publisher is disabled outright', () => {
    const locked = { allowed: false, reason: 'STAGING_UAT_LOCKED issue=#499 sha=x' }
    const sameHolder = { allowed: true, reason: 'LOCK_HELD_BY_REQUESTER_SAME_SHA' }
    const st = (operation, lock, extra = {}) => evaluateTrigger({ ...base, target: 'staging', event: 'workflow_dispatch', quality: qOk, input: { sha: A, operation, ...extra }, lock })
    for (const op of ['publish-m3', 'lock-uat']) expect(st(op, locked, { uatIssue: '7' })).toMatchObject({ run: false, fail: true, reason: locked.reason })
    // M2 writes a Public-only artifact under the same SHA tag: refused even when free or held by the same issue + SHA.
    for (const lock of [free, sameHolder, locked]) expect(st('publish', lock, { uatIssue: '7' })).toMatchObject({ run: false, fail: true, reason: 'LEGACY_M2_PUBLISH_DISABLED' })
    expect(st('lock-uat', free)).toMatchObject({ fail: true, reason: 'UAT_ISSUE_REQUIRED' })
    expect(st('lock-uat', free, { uatIssue: '7' })).toMatchObject({ run: true, operation: 'lock-uat' })
    expect(st('prepare-m3', locked).run).toBe(true) // builds only, never writes Staging
    expect(st('capture-snapshot', locked)).toMatchObject({ run: false, fail: false, reason: 'LEGACY_M2_OPERATION_NO_STAGING_WRITE' })
  })
})

let nextId = 1
const ownerComment = (body, created_at, over = {}) => ({ id: nextId++, body, created_at, updated_at: created_at, author_association: 'OWNER', user: { login: OWNER, type: 'User' }, ...over })

describe('#505 fixed Staging UAT lock', () => {
  const lockLine = (sha) => `STAGING-UAT-LOCK ${sha}`
  const holder = (number, ...comments) => ({ number, comments })
  it('binds the lock to one SHA: the holder may only retry that SHA; others are refused', () => {
    expect(evaluateLock({ holders: [], candidateSha: A })).toMatchObject({ state: 'free', allowed: true })
    const h = holder(499, ownerComment(lockLine(A), '2026-11-25T09:00:00Z'), ownerComment(lockLine(B), '2026-11-25T10:00:00Z'))
    expect(evaluateLock({ holders: [h], candidateSha: B })).toMatchObject({ state: 'held', lockedSha: B, allowed: false })
    expect(evaluateLock({ holders: [h], requestIssue: 499, candidateSha: B })).toMatchObject({ allowed: true, reason: 'LOCK_HELD_BY_REQUESTER_SAME_SHA' })
    expect(evaluateLock({ holders: [h], requestIssue: 499, candidateSha: C }).reason).toMatch(/^STAGING_UAT_LOCKED_DIFFERENT_SHA/)
    expect(evaluateLock({ holders: [h], requestIssue: 500, candidateSha: B }).allowed).toBe(false)
  })

  it('a label without exactly one valid SHA blocks everyone, the holder included (no auto-unlock)', () => {
    expect(evaluateLock({ holders: [holder(7)], requestIssue: 7, candidateSha: A })).toMatchObject({ state: 'unknown', allowed: false })
    const twoInOne = holder(7, ownerComment(`${lockLine(A)}\n${lockLine(B)}`, '2026-11-25T10:00:00Z'))
    expect(evaluateLock({ holders: [twoInOne], requestIssue: 7, candidateSha: A })).toMatchObject({ state: 'unknown', allowed: false })
    // Editing a lock line must not re-point a held lock to another SHA without release + re-acquire.
    const edited = holder(7, ownerComment(lockLine(B), '2026-11-25T10:00:00Z', { updated_at: '2026-11-25T10:05:00Z' }))
    expect(evaluateLock({ holders: [edited], requestIssue: 7, candidateSha: B })).toMatchObject({ state: 'unknown', allowed: false })
    expect(evaluateLock({ holders: [holder(1), holder(2)], candidateSha: A })).toMatchObject({ state: 'unknown', allowed: false })
    expect(evaluateLock({ holders: undefined, candidateSha: A })).toMatchObject({ state: 'unknown', allowed: false })
  })

  it('lock-uat pins only the combined M3 artifact: same SHA published by the legacy M2 publisher does not qualify', () => {
    expect(isCombinedStagingIdentity({ sha: A, message: `M3 Admin ${A}` }, A)).toBe(true)
    expect(isCombinedStagingIdentity({ sha: A, message: `M2 Public ${A}` }, A)).toBe(false)
    expect(isCombinedStagingIdentity({ sha: B, message: `M3 Admin ${B}` }, A)).toBe(false)
    expect(isCombinedStagingIdentity({ sha: A, message: '' }, A)).toBe(false)
  })

  it('ignores lock lines from untrusted authors, quotes, code and indented text; orders by time then id', () => {
    const t = '2026-11-25T11:00:00Z'
    const comments = [
      ownerComment(lockLine(A), '2026-11-25T09:00:00Z'),
      ownerComment(lockLine(B), '2026-11-25T10:00:00Z', { author_association: 'NONE', user: { login: 'random', type: 'User' } }),
      ownerComment(`> ${lockLine(C)}\n\`\`\`\n${lockLine(C)}\n\`\`\`\n    ${lockLine(C)}\n<!-- ${lockLine(C)} -->`, t),
    ]
    expect(lockedSha(comments)).toEqual({ sha: A, ambiguous: false })
    const sameTime = [ownerComment(lockLine(B), t), ownerComment(lockLine(C), t)]
    expect(lockedSha(sameTime).sha).toBe(C) // same timestamp: higher id is later
    const bot = { ...ownerComment(lockLine(C), '2026-11-25T12:00:00Z'), author_association: 'NONE', user: { login: 'github-actions[bot]', type: 'Bot' } }
    expect(lockedSha([...comments, bot]).sha).toBe(C)
  })
})

// --- D3-A GO evidence ---------------------------------------------------------------------------------------------------
const ISSUE = 600
const goUrl = (id) => `https://github.com/${REPO}/issues/${ISSUE}#issuecomment-${id}`
const stepsOf = (map) => Object.entries(map).map(([name, [conclusion, started_at = null, completed_at = null]]) => ({ name, conclusion, started_at, completed_at }))
const m4Run = (id, created_at, updated_at, over = {}, stepMap = {}) => ({
  id, path: '.github/workflows/m4-production-admin-release.yml', head_sha: A, head_branch: 'main', head_repository: { full_name: REPO },
  event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at, updated_at,
  jobs: [{ name: 'Build, verify and optionally publish the Production Admin Worker', steps: stepsOf({
    'Load the reviewed Production flags (release/production-flags.json, strict, no defaults)': ['success', created_at, created_at],
    'Require GO-PROD evidence for the exact candidate (publish only)': ['skipped'],
    'Verify the packaged Worker (Public parity from PostgreSQL, Admin fail-closed without secrets)': ['success', created_at, updated_at],
    'Publish with the Admin secrets passed atomically': ['skipped'], ...stepMap }) }],
  ...over,
})
const stagingRun = (id, sha, started, completed, conclusion = 'success', job = 'publish-m3') => ({
  id, path: '.github/workflows/v1-fixed-preview.yml', head_sha: sha, head_branch: 'main', head_repository: { full_name: REPO },
  event: 'workflow_run', status: 'completed', conclusion, created_at: started, updated_at: completed,
  jobs: [{ name: job, steps: stepsOf({ 'Publish only named staging and run hosted smoke': [conclusion, started, completed] }) }],
})
const VERIFY = m4Run(101, '2026-11-25T12:56:45Z', '2026-11-25T12:58:22Z')
const STAGE = stagingRun(201, A, '2026-11-25T13:02:12Z', '2026-11-25T13:06:19Z')
const GO_AT = '2026-11-25T13:24:38Z'
const goComment = (body, over = {}) => ({ ...ownerComment(body, GO_AT, over), id: 9001, html_url: goUrl(9001), issue_url: `https://api.github.com/repos/${REPO}/issues/${ISSUE}` })
const GOOD = `Owner duyệt.\nGO-PROD ${A}\nVERIFY-RUN 101\nUAT PASS ${A}`
const QUALITY = { id: 50, path: '.github/workflows/quality.yml', event: 'push', head_branch: 'main', head_sha: A, head_repository: { full_name: REPO },
  status: 'completed', conclusion: 'success', created_at: '2026-11-25T12:56:00Z' }
const goInput = (body = GOOD, over = {}) => ({
  url: goUrl(9001), comment: goComment(body), issue: { number: ISSUE, state: 'open' }, issueComments: [], m4Runs: [VERIFY],
  stagingRuns: [STAGE], qualityRuns: [QUALITY], candidateSha: A, lane: 'standard', fullTouch: {}, flagsChange: '', currentRunId: 999, ...over,
})
const reasonsFor = (body, over) => evaluateGo(goInput(body, over)).reasons

describe('#505 D3-A GO-PROD evidence', () => {
  it('passes a well-formed GO bound to a verify PASS, with UAT while Staging served the exact SHA', () => {
    expect(evaluateGo(goInput())).toMatchObject({ ok: true, lane: 'standard', uat: 'pass', verifyRunId: 101 })
    expect(evaluateGo(goInput(`GO-PROD ${A}\nVERIFY-RUN 101\nLANE extended\nUAT-WAIVER ${A} accepted on evidence #508`, { lane: 'extended' }))).toMatchObject({ ok: true, uat: 'waived' })
    expect(evaluateGo(goInput(`GO-PROD ${A}\nVERIFY-RUN 101`, { lane: 'none' }))).toMatchObject({ ok: true, uat: 'not-required' })
  })

  it('fast lane is not silently optional: it needs a short UAT or an explicit Owner waiver/deferral', () => {
    expect(reasonsFor(`GO-PROD ${A}\nVERIFY-RUN 101`, { lane: 'fast' })).toContain('UAT_EVIDENCE_MISSING')
    expect(evaluateGo(goInput(`GO-PROD ${A}\nVERIFY-RUN 101\nUAT-WAIVER ${A} batched with next release`, { lane: 'fast' })).ok).toBe(true)
  })

  it('UAT chronology: earlier unedited PASS counts; a later FAIL (before or after GO) or an edited PASS does not', () => {
    const uat = ownerComment(`UAT PASS ${A}`, '2026-11-25T13:10:00Z')
    expect(evaluateGo(goInput(`GO-PROD ${A}\nVERIFY-RUN 101`, { issueComments: [uat] })).ok).toBe(true)
    expect(reasonsFor(`GO-PROD ${A}\nVERIFY-RUN 101`, { issueComments: [uat, ownerComment(`UAT FAIL ${A}`, '2026-11-25T13:20:00Z')] })).toContain('UAT_FAILED')
    // Pre-deploy recheck sees a UAT FAIL posted after the GO.
    expect(reasonsFor(GOOD, { issueComments: [ownerComment(`UAT FAIL ${A}`, '2026-11-25T13:30:00Z')] })).toContain('UAT_FAILED_AFTER_GO')
    expect(reasonsFor(`GO-PROD ${A}\nVERIFY-RUN 101\nUAT-WAIVER ${A} ok`, { issueComments: [ownerComment(`UAT FAIL ${A}`, '2026-11-25T13:30:00Z')] })).toContain('UAT_FAILED_AFTER_GO')
    // Withdrawals count even when the comment was edited; approvals never do.
    expect(reasonsFor(GOOD, { issueComments: [ownerComment(`UAT FAIL ${A}`, '2026-11-25T13:30:00Z', { updated_at: '2026-11-25T13:31:00Z' })] })).toContain('UAT_FAILED_AFTER_GO')
    expect(reasonsFor(GOOD, { issueComments: [ownerComment(`NO-GO ${A}`, '2026-11-25T13:40:00Z', { updated_at: '2026-11-25T13:45:00Z' })] })).toContain('GO_REVOKED')
    expect(reasonsFor(GOOD, { issueComments: [ownerComment(`GO-PROD ${B}`, '2026-11-25T13:40:00Z', { updated_at: '2026-11-25T13:45:00Z' })] })).toContain('GO_SUPERSEDED')
    const edited = ownerComment(`UAT PASS ${A}`, '2026-11-25T13:10:00Z', { updated_at: '2026-11-25T13:11:00Z' })
    expect(reasonsFor(`GO-PROD ${A}\nVERIFY-RUN 101`, { issueComments: [edited] })).toContain('UAT_EVIDENCE_MISSING')
    expect(reasonsFor(`GO-PROD ${A}\nVERIFY-RUN 101`, { issueComments: [ownerComment(`UAT PASS ${A}\nUAT FAIL ${A}`, '2026-11-25T13:10:00Z')] })).toContain('UAT_AMBIGUOUS')
  })

  it('UAT counts only if fixed Staging already served the candidate, successfully, at the moment of the UAT', () => {
    const uatAt = (t) => [ownerComment(`UAT PASS ${A}`, t)]
    const body = `GO-PROD ${A}\nVERIFY-RUN 101`
    // Staging for the candidate finished AFTER the UAT PASS.
    expect(reasonsFor(body, { issueComments: uatAt('2026-11-25T13:04:00Z') })).toContain('UAT_STAGING_NOT_PASSED')
    // Another SHA was deployed between the candidate's Staging and the UAT (overwritten UAT).
    const overwrite = stagingRun(202, B, '2026-11-25T13:08:00Z', '2026-11-25T13:12:00Z')
    expect(reasonsFor(body, { issueComments: uatAt('2026-11-25T13:15:00Z'), stagingRuns: [STAGE, overwrite] })).toContain('UAT_STAGING_NOT_CANDIDATE')
    // Legacy M2 publish job counts as a Staging writer too, and never as UAT evidence: even with the SAME SHA it is Public-only.
    const legacy = stagingRun(203, B, '2026-11-25T13:08:00Z', '2026-11-25T13:12:00Z', 'success', 'publish')
    expect(reasonsFor(body, { issueComments: uatAt('2026-11-25T13:15:00Z'), stagingRuns: [STAGE, legacy] })).toContain('UAT_STAGING_NOT_CANDIDATE')
    const sameShaM2 = stagingRun(204, A, '2026-11-25T13:08:00Z', '2026-11-25T13:12:00Z', 'success', 'publish')
    expect(reasonsFor(body, { issueComments: uatAt('2026-11-25T13:15:00Z'), stagingRuns: [STAGE, sameShaM2] })).toContain('UAT_STAGING_NOT_COMBINED_ARTIFACT')
    // M2 first, then the combined M3 publish of the same SHA: Staging serves the combined artifact again, so the UAT counts.
    const m2First = stagingRun(205, A, '2026-11-25T12:50:00Z', '2026-11-25T12:55:00Z', 'success', 'publish')
    expect(evaluateGo(goInput(body, { issueComments: uatAt('2026-11-25T13:15:00Z'), stagingRuns: [m2First, STAGE] }))).toMatchObject({ ok: true, uat: 'pass' })
    expect(reasonsFor(GOOD, { stagingRuns: [] })).toContain('UAT_PASS_WITHOUT_STAGING_DEPLOYMENT')
    expect(stagingAt([STAGE], '2026-11-25T13:10:00Z')).toMatchObject({ sha: A, conclusion: 'success' })
  })

  it('verify evidence must be a trusted verify OPERATION bound by VERIFY-RUN and not invalidated by a newer failure', () => {
    const publishRun = m4Run(102, '2026-11-25T13:00:00Z', '2026-11-25T13:02:00Z', {}, {
      'Require GO-PROD evidence for the exact candidate (publish only)': ['success', '2026-11-25T13:00:10Z', '2026-11-25T13:00:20Z'],
      'Publish with the Admin secrets passed atomically': ['success', '2026-11-25T13:01:00Z', '2026-11-25T13:01:10Z'] })
    expect(isVerifyOperation(VERIFY)).toBe(true)
    expect(isVerifyOperation(publishRun)).toBe(false)
    expect(reasonsFor(GOOD.replace('VERIFY-RUN 101', 'VERIFY-RUN 102'), { m4Runs: [VERIFY, publishRun] })).toContain('VERIFY_RUN_NOT_A_TRUSTED_VERIFY_PASS')
    expect(reasonsFor(GOOD.replace('\nVERIFY-RUN 101', ''))).toContain('VERIFY_RUN_MISSING')
    const newerFail = m4Run(103, '2026-11-25T13:10:00Z', '2026-11-25T13:12:00Z', { conclusion: 'failure' }, {
      'Verify the packaged Worker (Public parity from PostgreSQL, Admin fail-closed without secrets)': ['failure'] })
    expect(reasonsFor(GOOD, { m4Runs: [VERIFY, newerFail] })).toContain('VERIFY_INVALIDATED_BY_NEWER_FAILURE')
    // A run that failed AFTER the packaged step (e.g. media/flags) is not a PASS either.
    const failedLater = m4Run(104, '2026-11-25T12:56:45Z', '2026-11-25T12:58:22Z', { conclusion: 'failure' })
    expect(reasonsFor(GOOD.replace('VERIFY-RUN 101', 'VERIFY-RUN 104'), { m4Runs: [failedLater] })).toContain('VERIFY_RUN_NOT_A_TRUSTED_VERIFY_PASS')
    const running = m4Run(105, '2026-11-25T13:20:00Z', '2026-11-25T13:20:00Z', { status: 'in_progress', conclusion: null })
    expect(reasonsFor(GOOD, { m4Runs: [VERIFY, running] })).toContain('VERIFY_STATE_AMBIGUOUS_RUN_IN_PROGRESS')
    expect(evaluateGo(goInput(GOOD, { m4Runs: [VERIFY, { ...running, id: 999 }] })).ok).toBe(true) // the current publish run itself
    expect(reasonsFor(GOOD, { m4Runs: [{ ...VERIFY, updated_at: '2026-11-25T14:00:00Z' }] })).toContain('GO_BEFORE_VERIFY_PASS')
    // A pre-#505 verify of the same SHA took its flags from dispatch inputs: it cannot prove the reviewed flags.
    const legacyVerify = { ...VERIFY, jobs: [{ ...VERIFY.jobs[0], steps: VERIFY.jobs[0].steps.filter((x) => !x.name.startsWith('Load the reviewed')) }] }
    expect(reasonsFor(GOOD, { m4Runs: [legacyVerify] })).toContain('VERIFY_RUN_NOT_A_TRUSTED_VERIFY_PASS')
    for (const over of [{ head_sha: B }, { head_branch: 'claude/x' }, { event: 'pull_request' }]) {
      expect(reasonsFor(GOOD, { m4Runs: [{ ...VERIFY, ...over }] })).toContain('VERIFY_RUN_NOT_A_TRUSTED_VERIFY_PASS')
    }
  })

  it.each([
    ['missing GO line (prose quoting the Owner)', `Owner xác nhận nguyên văn: "Owner GO-PROD exact SHA ${A}"\nVERIFY-RUN 101\nUAT PASS ${A}`, 'GO_LINE_MISSING'],
    ['GO only inside a quote', `> GO-PROD ${A}\nVERIFY-RUN 101\nUAT PASS ${A}`, 'GO_LINE_MISSING'],
    ['GO only inside a fenced block', `\`\`\`\nGO-PROD ${A}\n\`\`\`\nVERIFY-RUN 101\nUAT PASS ${A}`, 'GO_LINE_MISSING'],
    ['GO only as indented code', `Text\n\n    GO-PROD ${A}\nVERIFY-RUN 101\nUAT PASS ${A}`, 'GO_LINE_MISSING'],
    ['GO only inside an HTML comment', `<!--\nGO-PROD ${A}\n-->\nVERIFY-RUN 101\nUAT PASS ${A}`, 'GO_LINE_MISSING'],
    ['negated GO', `Không GO-PROD ${A}\nVERIFY-RUN 101\nUAT PASS ${A}`, 'GO_LINE_MISSING'],
    ['wrong SHA', `GO-PROD ${B}\nVERIFY-RUN 101\nUAT PASS ${A}`, 'GO_WRONG_SHA'],
    ['two GO lines', `GO-PROD ${A}\nGO-PROD ${B}\nVERIFY-RUN 101\nUAT PASS ${A}`, 'GO_LINE_AMBIGUOUS'],
    ['GO and NO-GO together', `${GOOD}\nNO-GO ${A}`, 'GO_CONTRADICTED_IN_SAME_COMMENT'],
    ['GO and UAT FAIL together', `${GOOD}\nUAT FAIL ${A}`, 'GO_CONTRADICTED_IN_SAME_COMMENT'],
    ['waiver without a reason', `GO-PROD ${A}\nVERIFY-RUN 101\nUAT-WAIVER ${A}`, 'UAT_EVIDENCE_MISSING'],
    ['stale flag change line', `${GOOD}\nFLAGS-CHANGE commerce=off`, 'FLAGS_CHANGE_STALE'],
  ])('refuses: %s', (_name, body, reason) => expect(reasonsFor(body)).toContain(reason))

  it('lane: extended/full need an explicit line, never lowered; unknown scope is full', () => {
    expect(reasonsFor(GOOD, { lane: 'extended' })).toContain('LANE_ACK_REQUIRED')
    expect(reasonsFor(`${GOOD}\nLANE standard`, { lane: 'full' })).toContain('LANE_LOWERED')
    expect(reasonsFor(GOOD, { lane: undefined, fullTouch: null })).toEqual(expect.arrayContaining(['LANE_ACK_REQUIRED', 'FULL_SCOPE_UNKNOWN']))
  })

  it('full scope (SQL, function, bindings) is never published without a reviewed plan, whatever other evidence is offered', () => {
    // A successful M6 rollback or an unrelated single apply must not count as proof that a schema change was applied.
    const offered = `${GOOD}\nLANE full\nFULL-EVIDENCE sql https://github.com/${REPO}/actions/runs/301`
    for (const touch of [{ sql: C }, { function: C }, { bindings: C }, { sql: C, function: B }]) {
      const r = evaluateGo(goInput(offered, { lane: 'full', fullTouch: touch }))
      expect(r.ok).toBe(false)
      expect(r.reasons).toContain('FULL_SCOPE_REQUIRES_PLAN')
    }
    // An Owner may still raise a Worker-only release to LANE full voluntarily.
    expect(evaluateGo(goInput(`${GOOD}\nLANE full`, { lane: 'extended', fullTouch: {} })).ok).toBe(true)
  })

  it('needs a successful trusted quality push run on main for the exact SHA (recheck sees a later failure)', () => {
    expect(reasonsFor(GOOD, { qualityRuns: [] })).toContain('QUALITY_NOT_PASSED state=missing')
    expect(reasonsFor(GOOD, { qualityRuns: [{ ...QUALITY, conclusion: 'failure' }] })).toContain('QUALITY_NOT_PASSED state=failure')
    expect(reasonsFor(GOOD, { qualityRuns: [QUALITY, { ...QUALITY, id: 51, created_at: '2026-11-25T13:30:00Z', status: 'in_progress', conclusion: null }] }))
      .toContain('QUALITY_STATE_AMBIGUOUS_RUN_IN_PROGRESS')
    expect(reasonsFor(GOOD, { qualityRuns: [{ ...QUALITY, event: 'pull_request' }] })).toContain('QUALITY_NOT_PASSED state=missing')
  })

  it('refuses a non-Owner, edited, superseded or revoked GO, a closed issue, a PR and a URL outside this repository', () => {
    expect(evaluateGo(goInput(GOOD, { comment: goComment(GOOD, { author_association: 'NONE', user: { login: 'random' } }) })).reasons).toContain('GO_NOT_OWNER_COMMENT')
    expect(evaluateGo(goInput(GOOD, { comment: goComment(GOOD, { updated_at: '2026-11-25T13:30:00Z' }) })).reasons).toContain('GO_COMMENT_EDITED')
    expect(reasonsFor(GOOD, { issueComments: [ownerComment(`GO-PROD ${B}`, '2026-11-25T13:40:00Z')] })).toContain('GO_SUPERSEDED')
    expect(reasonsFor(GOOD, { issueComments: [ownerComment(`GO-PROD-REVOKE ${A}`, '2026-11-25T13:40:00Z')] })).toContain('GO_REVOKED')
    expect(reasonsFor(GOOD, { issueComments: [ownerComment(`NO-GO ${A}`, GO_AT, { id: 9002 })] })).toContain('GO_REVOKED') // same time, later id
    expect(evaluateGo(goInput(GOOD, { issueComments: [ownerComment(`NO-GO ${A}`, '2026-11-25T13:40:00Z', { author_association: 'NONE', user: { login: 'x' } })] })).ok).toBe(true)
    expect(reasonsFor(GOOD, { issue: { number: ISSUE, state: 'closed' } })).toContain('GO_ISSUE_CLOSED')
    expect(reasonsFor(GOOD, { issue: { number: ISSUE, state: 'open', pull_request: {} } })).toContain('GO_NOT_ON_RELEASE_ISSUE')
    expect(reasonsFor(GOOD, { url: `https://github.com/evil/repo/issues/${ISSUE}#issuecomment-9001` })).toContain('GO_URL_WRONG_REPOSITORY')
    expect(reasonsFor(GOOD, { url: '' })).toContain('GO_URL_INVALID')
    expect(reasonsFor(GOOD, { flagsChange: 'commerce=off' })).toContain('FLAGS_CHANGE_NOT_APPROVED')
  })

  it('only whole column-0 lines outside quotes, code and HTML comments are directives', () => {
    expect(parseDirectives(`**GO-PROD ${A}**\n\`GO-PROD ${A}\`\n  GO-PROD ${A}\nGO-PROD ${A}  `)).toEqual([{ type: 'go', value: A, extra: undefined, args: [A] }])
    expect(plainLines('a\n~~~\nb\n~~~\n> c\n\tx\n<!-- y -->d')).toEqual(['a', 'd'])
  })
})

describe('#505 evidence summary', () => {
  const ok = { CANDIDATE_SHA: A, MODE: 'auto', OPERATION: 'verify', JOB_STATUS: 'success', ACTIVE_OUTCOME: 'success', FLAGS_OUTCOME: 'success',
    PRODUCTION_SHA: B, ACTIVE_VERSION: live.id, RISK_LANE: 'extended', CHANGED_FILES: '3', CANONICAL_PRICING: 'on', CANONICAL_BRANDS: 'toto,inax',
    COMMERCE: 'on', SERIES_VARIANT: 'off', FLAGS_DIGEST: 'abc', PACKAGED: 'success', MEDIA: 'skipped', RUN_ID: '101', FULL_TOUCH: '{}' }
  const links = { qualityState: 'success', quality: '[1](u)', staging: '[2](u) success' }
  it('prints the GO template, bound to this verify run, only when READY; says READY is not UAT or GO; no secrets', () => {
    const md = renderEvidence(ok, links)
    expect(md).toContain(`GO-PROD ${A}\nVERIFY-RUN 101\nLANE extended\nUAT PASS ${A}`)
    expect(md).toContain(`rollback_version_id=${live.id}`)
    expect(md).toContain('**READY**')
    expect(md).toContain('it is not UAT acceptance and not a GO')
    expect(md).not.toMatch(/secret|token|password/i)
  })
  it.each([
    ['job failed after the packaged step', { JOB_STATUS: 'failure' }, {}],
    ['packaged verify failed', { PACKAGED: 'failure', JOB_STATUS: 'failure' }, {}],
    ['manual media test failed (continue-on-error)', { MODE: 'manual', MEDIA: 'failure' }, {}],
    ['production SHA unknown', { PRODUCTION_SHA: 'UNKNOWN' }, {}],
    ['production SHA known but diff unknown', { FULL_TOUCH: 'unknown' }, {}],
    ['full scope (sql)', { RISK_LANE: 'full', FULL_TOUCH: JSON.stringify({ sql: C }) }, {}],
    ['live flags unknown', { ACTIVE_OUTCOME: 'failure' }, {}],
    ['flags file failed', { FLAGS_OUTCOME: 'failure' }, {}],
    ['publish run', { OPERATION: 'publish' }, {}],
    ['quality failed', {}, { qualityState: 'failure' }],
    ['quality missing', {}, { qualityState: 'missing' }],
    ['quality pending', {}, { qualityState: 'pending' }],
  ])('NOT READY and no GO template when %s', (_n, over, linkOver) => {
    expect(readiness({ ...ok, ...over }, { ...links, ...linkOver }).status).toBe('NOT READY')
    expect(renderEvidence({ ...ok, ...over }, { ...links, ...linkOver })).not.toContain('GO-PROD')
  })
})
