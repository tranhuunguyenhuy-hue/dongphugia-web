// #505 Lean Release Pipeline: unit tests and negative gates (pure functions, no network).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { diffFlags, flagsDigest, flagsFromBindings, formatFlagsChange, loadFlags, parseFlags } from './flags.mjs'
import { evaluateGo, parseDirectives } from './go-evidence.mjs'
import { activeVersionId, plainLines } from './lib.mjs'
import { renderEvidence } from './release-evidence.mjs'
import { classifyLane, laneForPath } from './risk-lane.mjs'
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
      JSON.stringify({ schema: 1, canonical_pricing: 'on', canonical_brands: 'toto,inax', series_variant: 'off' }), // commerce missing
      flagsText({ extra: 'x' }), flagsText({ schema: 2 }), flagsText({ canonical_pricing: 'true' }), flagsText({ commerce: true }),
      flagsText({ canonical_brands: 'toto,caesar' }), flagsText({ canonical_pricing: 'off' }), // brands must be '' when off
      flagsText({ series_variant: 'on' }), flagsText({ commerce: '' }),
    ]) expect(() => parseFlags(bad), bad).toThrow()
    expect(parseFlags(flagsText({ canonical_pricing: 'off', canonical_brands: '' })).canonical_pricing).toBe('off')
  })

  it('treats inconsistent live bindings as UNKNOWN (fail closed) and reports intentional changes exactly', () => {
    const without = (name) => live.resources.bindings.filter((b) => b.name !== name)
    expect(() => flagsFromBindings(without('ORDER_INTAKE_DB'))).toThrow(/commerce/) // flag on without intake binding
    expect(() => flagsFromBindings(without('PUBLIC_CANONICAL_PRICE_BRANDS'))).toThrow(/canonical_pricing/)
    expect(() => flagsFromBindings([...live.resources.bindings, { name: 'PUBLIC_SERIES_VARIANT', type: 'plain_text', text: 'maybe' }])).toThrow()
    const commerceOff = parseFlags(flagsText({ commerce: 'off' }))
    const diff = diffFlags(commerceOff, flagsFromBindings(live.resources.bindings))
    expect(formatFlagsChange(diff)).toBe('commerce=off')
    const pricingOff = parseFlags(flagsText({ canonical_pricing: 'off', canonical_brands: '' }))
    expect(formatFlagsChange(diffFlags(pricingOff, flagsFromBindings(live.resources.bindings)))).toBe('canonical_pricing=off;canonical_brands=-')
  })

  it('reads exactly one active version and refuses split traffic or an empty deployment list', () => {
    expect(activeVersionId({ deployments: [{ created_on: '2026-11-25T13:28:30Z', versions: [{ version_id: live.id, percentage: 100 }] }] })).toBe(live.id)
    expect(() => activeVersionId({ deployments: [] })).toThrow()
    expect(() => activeVersionId({ deployments: [{ created_on: 'x', versions: [{ version_id: live.id, percentage: 50 }, { version_id: live.id, percentage: 50 }] }] })).toThrow()
  })
})

describe('#505 risk lane floor', () => {
  it.each([
    ['docs/ops/v1-fast-release.md', 'none'], ['scripts/release/release.test.mjs', 'none'],
    ['src/app/globals.css', 'fast'], ['public/banners/home.webp', 'fast'],
    ['src/components/layout/header.tsx', 'standard'], ['src/components/blog/author-card.tsx', 'standard'],
    ['src/components/cart/CartDrawer.tsx', 'extended'], ['src/app/(public)/gio-hang/page.tsx', 'extended'],
    ['src/lib/canonical-price.ts', 'extended'], ['apps/public/worker.ts', 'extended'], ['release/production-flags.json', 'extended'],
    ['apps/admin-spa/src/Sales.tsx', 'extended'], ['unknown/thing.txt', 'extended'],
    ['prisma/schema.prisma', 'full'], ['supabase/functions/admin-api/index.ts', 'full'], ['.github/workflows/quality.yml', 'full'],
    ['apps/public/wrangler.production.jsonc', 'full'],
  ])('%s → %s', (path, lane) => expect(laneForPath(path)).toBe(lane))

  it('takes the highest lane of a change set (cannot be lowered by mixing in docs)', () => {
    expect(classifyLane(['docs/a.md', 'src/app/globals.css']).lane).toBe('fast')
    expect(classifyLane(['docs/a.md', 'src/components/x.tsx', 'src/lib/db.ts']).lane).toBe('extended')
    expect(classifyLane([]).lane).toBe('none')
  })
})

const base = { target: 'm4', repo: REPO, ref: 'refs/heads/main', actor: OWNER, githubSha: A, mainHead: A }
const wr = { path: '.github/workflows/quality.yml', event: 'push', headBranch: 'main', headRepo: REPO, conclusion: 'success', actor: OWNER, headSha: A }
const free = { allowed: true, reason: 'LOCK_FREE' }

describe('#505 D1 trigger gate', () => {
  it('auto-preflight: trusted main push yields verify only (auto publish impossible)', () => {
    const d = evaluateTrigger({ ...base, event: 'workflow_run', workflowRun: wr, pushLane: 'standard' })
    expect(d).toMatchObject({ run: true, mode: 'auto', operation: 'verify', sha: A })
    expect(evaluateTrigger({ ...base, target: 'staging', event: 'workflow_run', workflowRun: wr, pushLane: 'fast', lock: free }))
      .toMatchObject({ run: true, mode: 'auto', operation: 'publish-m3' })
  })

  it.each([
    ['PR quality run', { event: 'pull_request' }], ['fork head', { headRepo: 'evil/dongphugia-web' }],
    ['non-main branch', { headBranch: 'feature' }], ['failed quality', { conclusion: 'failure' }],
    ['other workflow', { path: '.github/workflows/homepage-quality.yml' }], ['other actor', { actor: 'someone' }],
    ['superseded head', { headSha: B }],
  ])('auto-preflight skips untrusted/stale trigger: %s', (_name, over) => {
    const d = evaluateTrigger({ ...base, event: 'workflow_run', workflowRun: { ...wr, ...over }, pushLane: 'standard' })
    expect(d.run).toBe(false)
    expect(d.fail).toBe(false)
  })

  it('auto-preflight skips docs-only and full-lane pushes and a locked Staging, with a reason', () => {
    expect(evaluateTrigger({ ...base, event: 'workflow_run', workflowRun: wr, pushLane: 'none' }).reason).toBe('NO_RUNTIME_CHANGE')
    expect(evaluateTrigger({ ...base, event: 'workflow_run', workflowRun: wr, pushLane: 'full' }).reason).toBe('FULL_LANE_SEPARATE_GATES')
    expect(evaluateTrigger({ ...base, event: 'workflow_run', workflowRun: wr, mainHead: B, pushLane: 'standard' }).reason).toMatch(/SUPERSEDED/)
    const locked = { allowed: false, reason: 'STAGING_UAT_LOCKED issue=#499 sha=x' }
    const d = evaluateTrigger({ ...base, target: 'staging', event: 'workflow_run', workflowRun: wr, pushLane: 'standard', lock: locked })
    expect(d).toMatchObject({ run: false, fail: false, reason: locked.reason })
  })

  it('manual dispatch keeps the identity rules and refuses misuse loudly', () => {
    expect(evaluateTrigger({ ...base, event: 'workflow_dispatch', input: { sha: A, operation: 'publish' } })).toMatchObject({ run: true, mode: 'manual', operation: 'publish' })
    for (const [over, reason] of [
      [{ input: { sha: B, operation: 'verify' } }, 'APPROVED_SHA_NOT_DISPATCHED_MAIN'],
      [{ input: { sha: A, operation: 'verify' }, ref: 'refs/heads/claude/x' }, 'REF_NOT_MAIN'],
      [{ input: { sha: A, operation: 'verify' }, actor: 'someone' }, 'ACTOR_NOT_ALLOWED'],
      [{ input: { sha: A, operation: 'verify' }, repo: 'evil/repo' }, 'REPOSITORY_NOT_ALLOWED'],
      [{ input: { sha: A, operation: 'verify' }, mainHead: B }, 'SUPERSEDED main=' + B],
      [{ input: { sha: A, operation: 'deploy' } }, 'OPERATION_INVALID'],
      [{ event: 'push', input: {} }, 'EVENT_NOT_ALLOWED'],
    ]) expect(evaluateTrigger({ ...base, event: 'workflow_dispatch', ...over })).toMatchObject({ run: false, fail: true, reason })
  })

  it('manual Staging publish is refused while another issue holds the UAT lock; legacy M2 ops pass through', () => {
    const locked = { allowed: false, reason: 'STAGING_UAT_LOCKED issue=#499 sha=x' }
    expect(evaluateTrigger({ ...base, target: 'staging', event: 'workflow_dispatch', input: { sha: A, operation: 'publish-m3' }, lock: locked }))
      .toMatchObject({ run: false, fail: true, reason: locked.reason })
    expect(evaluateTrigger({ ...base, target: 'staging', event: 'workflow_dispatch', input: { sha: A, operation: 'prepare-m3' }, lock: locked }).run).toBe(true)
    expect(evaluateTrigger({ ...base, target: 'staging', event: 'workflow_dispatch', input: { sha: A, operation: 'capture-snapshot' } }))
      .toMatchObject({ run: false, fail: false, reason: 'LEGACY_M2_OPERATION' })
  })
})

const ownerComment = (id, body, created_at, over = {}) => ({ id, body, created_at, updated_at: created_at, author_association: 'OWNER', user: { login: OWNER, type: 'User' }, ...over })

describe('#505 fixed Staging UAT lock', () => {
  const lockLine = (sha) => `STAGING-UAT-LOCK ${sha}`
  it('is free with no labelled issue and held otherwise, bound to the latest trusted lock line', () => {
    expect(evaluateLock({ holders: [] })).toMatchObject({ state: 'free', allowed: true })
    const holder = { number: 499, comments: [ownerComment(1, lockLine(A), '2026-11-25T09:00:00Z'), ownerComment(2, lockLine(B), '2026-11-25T10:00:00Z')] }
    expect(evaluateLock({ holders: [holder] })).toMatchObject({ state: 'held', holder: 499, lockedSha: B, allowed: false })
    expect(evaluateLock({ holders: [holder], requestIssue: 499 })).toMatchObject({ allowed: true, reason: 'LOCK_HELD_BY_REQUESTER' })
    expect(evaluateLock({ holders: [holder], requestIssue: 500 }).allowed).toBe(false)
  })

  it('ignores lock lines from untrusted authors, quotes and code blocks; never auto-unlocks ambiguous state', () => {
    const comments = [
      ownerComment(1, lockLine(A), '2026-11-25T09:00:00Z'),
      ownerComment(2, lockLine(B), '2026-11-25T10:00:00Z', { author_association: 'NONE', user: { login: 'random', type: 'User' } }),
      ownerComment(3, `> ${lockLine(C)}\n\`\`\`\n${lockLine(C)}\n\`\`\``, '2026-11-25T11:00:00Z'),
      { ...ownerComment(4, lockLine(C), '2026-11-25T08:00:00Z'), author_association: 'NONE', user: { login: 'github-actions[bot]', type: 'Bot' } },
    ]
    expect(lockedSha(comments)).toBe(A) // bot line is older; untrusted/quoted lines ignored
    expect(evaluateLock({ holders: [{ number: 1, comments: [] }, { number: 2, comments: [] }] })).toMatchObject({ state: 'unknown', allowed: false })
    expect(evaluateLock({ holders: undefined })).toMatchObject({ state: 'unknown', allowed: false })
    expect(evaluateLock({ holders: [{ number: 7, comments: [] }] })).toMatchObject({ state: 'held', lockedSha: null, allowed: false })
  })
})

// --- D3-A GO evidence ---------------------------------------------------------------------------------------------------
const ISSUE = 600
const goUrl = (id) => `https://github.com/${REPO}/issues/${ISSUE}#issuecomment-${id}`
const run = (id, path, updated_at, over = {}) => ({
  id, path, head_sha: A, head_branch: 'main', head_repository: { full_name: REPO }, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', updated_at,
  jobs: path.includes('m4-') ? [{ name: 'Build, verify and optionally publish the Production Admin Worker', conclusion: 'success', steps: [{ name: 'Verify the packaged Worker (Public parity from PostgreSQL, Admin fail-closed without secrets)', conclusion: 'success' }] }]
    : [{ name: 'publish-m3', conclusion: 'success', steps: [{ name: 'Publish only named staging and run hosted smoke', conclusion: 'success' }] }],
  ...over,
})
const verifyRun = run(1, '.github/workflows/m4-production-admin-release.yml', '2026-11-25T12:58:22Z')
const stagingRun = run(2, '.github/workflows/v1-fixed-preview.yml', '2026-11-25T13:06:21Z')
const goComment = (body, over = {}) => ({ ...ownerComment(9001, body, '2026-11-25T13:24:38Z', over), html_url: goUrl(9001), issue_url: `https://api.github.com/repos/${REPO}/issues/${ISSUE}` })
const goInput = (body, over = {}) => ({
  url: goUrl(9001), comment: goComment(body), issue: { number: ISSUE, state: 'open' }, issueComments: [], verifyRuns: [verifyRun],
  stagingRuns: [stagingRun], candidateSha: A, lane: 'standard', flagsChange: '', ...over,
})

describe('#505 D3-A GO-PROD evidence', () => {
  it('passes a well-formed GO after verify PASS with UAT on the exact staged SHA', () => {
    const r = evaluateGo(goInput(`Owner duyệt.\nGO-PROD ${A}\nUAT PASS ${A}`))
    expect(r).toMatchObject({ ok: true, lane: 'standard', uat: 'pass', verifyRunIds: [1] })
    expect(evaluateGo(goInput(`GO-PROD ${A}\nLANE extended\nUAT-WAIVER ${A} accepted on evidence #508`, { lane: 'extended' }))).toMatchObject({ ok: true, uat: 'waived' })
    expect(evaluateGo(goInput(`GO-PROD ${A}`, { lane: 'fast' }))).toMatchObject({ ok: true, uat: 'not-required' })
  })

  it('accepts UAT PASS from an earlier unedited Owner comment, and rejects a later UAT FAIL', () => {
    const uat = ownerComment(8000, `UAT PASS ${A}`, '2026-11-25T12:39:14Z')
    expect(evaluateGo(goInput(`GO-PROD ${A}`, { issueComments: [uat] })).ok).toBe(true)
    const failAfter = ownerComment(8001, `UAT FAIL ${A}`, '2026-11-25T13:00:00Z')
    expect(evaluateGo(goInput(`GO-PROD ${A}`, { issueComments: [uat, failAfter] })).reasons).toContain('UAT_FAILED')
  })

  const reasonsFor = (body, over) => evaluateGo(goInput(body, over)).reasons
  it.each([
    ['missing GO line (prose quoting the Owner)', `Owner xác nhận nguyên văn: "Owner GO-PROD exact SHA ${A}"`, {}, 'GO_LINE_MISSING'],
    ['GO only inside a quote', `> GO-PROD ${A}\nUAT PASS ${A}`, {}, 'GO_LINE_MISSING'],
    ['GO only inside a code block', `\`\`\`\nGO-PROD ${A}\n\`\`\`\nUAT PASS ${A}`, {}, 'GO_LINE_MISSING'],
    ['negated GO', `Không GO-PROD ${A}\nUAT PASS ${A}`, {}, 'GO_LINE_MISSING'],
    ['wrong SHA', `GO-PROD ${B}\nUAT PASS ${A}`, {}, 'GO_WRONG_SHA'],
    ['two GO lines', `GO-PROD ${A}\nGO-PROD ${B}\nUAT PASS ${A}`, {}, 'GO_LINE_AMBIGUOUS'],
    ['GO and NO-GO together', `GO-PROD ${A}\nNO-GO ${A}\nUAT PASS ${A}`, {}, 'GO_CONTRADICTED_IN_SAME_COMMENT'],
    ['no verify PASS', `GO-PROD ${A}\nUAT PASS ${A}`, { verifyRuns: [] }, 'VERIFY_PASS_MISSING'],
    ['GO posted before verify finished', `GO-PROD ${A}\nUAT PASS ${A}`, { verifyRuns: [{ ...verifyRun, updated_at: '2026-11-25T14:00:00Z' }] }, 'GO_BEFORE_VERIFY_PASS'],
    ['verify step failed', `GO-PROD ${A}\nUAT PASS ${A}`, { verifyRuns: [{ ...verifyRun, jobs: [{ ...verifyRun.jobs[0], steps: [{ ...verifyRun.jobs[0].steps[0], conclusion: 'failure' }] }] }] }, 'VERIFY_PASS_MISSING'],
    ['verify on another SHA', `GO-PROD ${A}\nUAT PASS ${A}`, { verifyRuns: [{ ...verifyRun, head_sha: B }] }, 'VERIFY_PASS_MISSING'],
    ['verify from a PR branch', `GO-PROD ${A}\nUAT PASS ${A}`, { verifyRuns: [{ ...verifyRun, head_branch: 'claude/x' }] }, 'VERIFY_PASS_MISSING'],
    ['verify from an untrusted event', `GO-PROD ${A}\nUAT PASS ${A}`, { verifyRuns: [{ ...verifyRun, event: 'pull_request' }] }, 'VERIFY_PASS_MISSING'],
    ['UAT missing for standard', `GO-PROD ${A}`, {}, 'UAT_EVIDENCE_MISSING'],
    ['UAT PASS but never staged', `GO-PROD ${A}\nUAT PASS ${A}`, { stagingRuns: [] }, 'UAT_PASS_WITHOUT_STAGING_DEPLOYMENT'],
    ['UAT on another SHA', `GO-PROD ${A}\nUAT PASS ${B}`, {}, 'UAT_EVIDENCE_MISSING'],
    ['waiver without a reason', `GO-PROD ${A}\nUAT-WAIVER ${A}`, {}, 'UAT_EVIDENCE_MISSING'],
    ['extended without LANE ack', `GO-PROD ${A}\nUAT PASS ${A}`, { lane: 'extended' }, 'LANE_ACK_REQUIRED'],
    ['LANE lowered', `GO-PROD ${A}\nLANE standard\nUAT PASS ${A}`, { lane: 'full' }, 'LANE_LOWERED'],
    ['unknown scope treated as full', `GO-PROD ${A}\nUAT PASS ${A}`, { lane: undefined }, 'LANE_ACK_REQUIRED'],
    ['flag change not approved', `GO-PROD ${A}\nUAT PASS ${A}`, { flagsChange: 'commerce=off' }, 'FLAGS_CHANGE_NOT_APPROVED'],
    ['flag change mismatch', `GO-PROD ${A}\nUAT PASS ${A}\nFLAGS-CHANGE commerce=on`, { flagsChange: 'commerce=off' }, 'FLAGS_CHANGE_NOT_APPROVED'],
    ['stale flag change line', `GO-PROD ${A}\nUAT PASS ${A}\nFLAGS-CHANGE commerce=off`, {}, 'FLAGS_CHANGE_STALE'],
    ['closed release issue', `GO-PROD ${A}\nUAT PASS ${A}`, { issue: { number: ISSUE, state: 'closed' } }, 'GO_ISSUE_CLOSED'],
    ['GO on a pull request', `GO-PROD ${A}\nUAT PASS ${A}`, { issue: { number: ISSUE, state: 'open', pull_request: {} } }, 'GO_NOT_ON_RELEASE_ISSUE'],
  ])('refuses: %s', (_name, body, over, reason) => expect(reasonsFor(body, over)).toContain(reason))

  it('refuses a non-Owner, edited, superseded or revoked GO and a URL outside this repository', () => {
    const body = `GO-PROD ${A}\nUAT PASS ${A}`
    expect(evaluateGo(goInput(body, { comment: goComment(body, { author_association: 'NONE', user: { login: 'random' } }) })).reasons).toContain('GO_NOT_OWNER_COMMENT')
    expect(evaluateGo(goInput(body, { comment: goComment(body, { updated_at: '2026-11-25T13:30:00Z' }) })).reasons).toContain('GO_COMMENT_EDITED')
    expect(evaluateGo(goInput(body, { issueComments: [ownerComment(9100, `GO-PROD ${B}`, '2026-11-25T13:40:00Z')] })).reasons).toContain('GO_SUPERSEDED')
    expect(evaluateGo(goInput(body, { issueComments: [ownerComment(9101, `GO-PROD-REVOKE ${A}`, '2026-11-25T13:40:00Z')] })).reasons).toContain('GO_REVOKED')
    expect(evaluateGo(goInput(body, { issueComments: [ownerComment(9102, `NO-GO ${A}`, '2026-11-25T13:40:00Z', { author_association: 'NONE', user: { login: 'random' } })] })).ok).toBe(true)
    expect(evaluateGo(goInput(body, { url: `https://github.com/evil/repo/issues/${ISSUE}#issuecomment-9001` })).reasons).toContain('GO_URL_WRONG_REPOSITORY')
    expect(evaluateGo(goInput(body, { url: '' })).reasons).toContain('GO_URL_INVALID')
  })

  it('only whole unquoted lines are directives', () => {
    expect(parseDirectives(`**GO-PROD ${A}**\n\`GO-PROD ${A}\`\n  GO-PROD ${A}  `)).toEqual([{ type: 'go', value: A, extra: undefined }])
    expect(plainLines('a\n~~~\nb\n~~~\n> c\nd')).toEqual(['a', 'd'])
  })
})

describe('#505 evidence summary', () => {
  it('prints pinned SHA, rollback target, flags and the exact GO template; no secrets', () => {
    const md = renderEvidence({ CANDIDATE_SHA: A, MODE: 'auto', OPERATION: 'verify', PRODUCTION_SHA: B, ACTIVE_VERSION: live.id, RISK_LANE: 'extended',
      CHANGED_FILES: '3', CANONICAL_PRICING: 'on', CANONICAL_BRANDS: 'toto,inax', COMMERCE: 'on', SERIES_VARIANT: 'off', FLAGS_DIGEST: 'abc', PACKAGED: 'success', MEDIA: 'skipped' })
    expect(md).toContain(`GO-PROD ${A}\nLANE extended\nUAT PASS ${A}`)
    expect(md).toContain(`rollback_version_id=${live.id}`)
    expect(md).toContain('SKIPPED (auto verify is read-only')
    expect(md).not.toMatch(/secret|token|password/i)
    expect(renderEvidence({ CANDIDATE_SHA: A, OPERATION: 'verify', PACKAGED: 'failure' })).not.toContain('GO-PROD')
  })
})
