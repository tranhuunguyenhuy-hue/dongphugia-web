import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// #470 history: flags were dispatch inputs with a default of 'off' (a publish with defaults would silently switch pricing/commerce off).
// #505 D2: flags are code (release/production-flags.json); the lane must never take them from inputs again.
const workflow = readFileSync('.github/workflows/m4-production-admin-release.yml', 'utf8')
const staging = readFileSync('.github/workflows/v1-fixed-preview.yml', 'utf8')
const step = (text, name) => {
  const start = text.indexOf(`- name: ${name}`)
  expect(start, name).toBeGreaterThan(-1)
  const next = text.indexOf('\n      - ', start + 1)
  return text.slice(start, next < 0 ? undefined : next)
}

describe('#505 M4 release lane contract', () => {
  it('has no flag inputs and no owner_ready_confirmed boolean; publish needs a GO comment URL', () => {
    for (const removed of ['canonical_pricing:', 'canonical_brands:', 'commerce:', 'owner_ready_confirmed', "default: 'off'", 'inputs.canonical', 'inputs.commerce']) {
      expect(workflow).not.toContain(removed)
    }
    expect(workflow).toContain('go_comment_url:')
    expect(workflow).toContain('node scripts/release/flags.mjs load release/production-flags.json')
  })

  it('feeds the configure scripts and identity checks only from the flags file outputs', () => {
    const build = step(workflow, 'Build the actual Public Worker and assemble the Public release')
    expect(build).toContain('CANONICAL_PRICING: ${{ steps.flags.outputs.canonical_pricing }}')
    expect(build).toContain('configure-canonical-pricing.mjs apps/public/wrangler.jsonc "$CANONICAL_PRICING" "$CANONICAL_BRANDS"')
    expect(build).toContain('configure-commerce.mjs apps/public/wrangler.jsonc "$COMMERCE"')
    expect(step(workflow, 'Confirm exact target, bindings and Wrangler dry-run')).toContain("fail('series-variant')")
    expect(step(workflow, 'Verify the deployed version bindings and record rollback evidence')).toContain('flags.mjs check-version')
  })

  it('auto-preflight comes only from quality on main and can never publish', () => {
    expect(workflow).toMatch(/workflow_run:\n\s+workflows: \[quality\]\n\s+types: \[completed\]\n\s+branches: \[main\]/)
    expect(workflow).toContain("PUBLISH: ${{ needs.gate.outputs.operation == 'publish' && github.event_name == 'workflow_dispatch' }}")
    for (const name of ['Publish with the Admin secrets passed atomically', 'Verify the active version equals the recorded rollback target before publishing',
      'Recheck main HEAD and the GO-PROD evidence right before publishing', 'Require GO-PROD evidence for the exact candidate (publish only)']) {
      expect(step(workflow, name)).toContain("if: env.PUBLISH == 'true'")
    }
    // The auto verify is strictly read-only: the Production media PUT/DELETE test object runs only for manual runs.
    expect(step(workflow, 'Verify the Production media target with a unique test object (no overwrite)')).toContain("if: needs.gate.outputs.mode == 'manual'")
    // The privileged job runs only after the unprivileged gate, on protected main, for the exact pinned SHA.
    expect(workflow).toContain("needs.gate.outputs.run == 'true' &&")
    expect(workflow).toContain('needs.gate.outputs.sha == github.sha')
    expect(workflow.slice(workflow.indexOf('  gate:'), workflow.indexOf('  release:'))).not.toContain('secrets.')
  })

  it('keeps publish serialized with every Production release; verifies queue per SHA', () => {
    expect(workflow).toContain("inputs.operation == 'publish' && 'v1-production-worker-release' || format('m4-verify-{0}'")
    expect(workflow).toContain('cancel-in-progress: false')
  })
})

describe('#505 fixed Staging lane contract', () => {
  it('rechecks the UAT lock and newest main right before deploying, and only manual runs take the lock', () => {
    expect(step(staging, 'Recheck newest main and the UAT lock right before deploying')).toContain('staging-lock.mjs recheck')
    expect(step(staging, 'Publish only named staging and run hosted smoke')).toContain("if: steps.recheck.outputs.go == 'true'")
    expect(step(staging, 'Take the Staging UAT lock for the requesting issue (manual publish with uat_issue)'))
      .toContain("if: steps.publish.outcome == 'success' && env.MODE == 'manual' && env.UAT_ISSUE != ''")
    expect(staging).toContain('group: m2-fixed-staging')
    expect(staging.slice(staging.indexOf('  gate:'), staging.indexOf('  prepare:'))).not.toContain('secrets.')
  })
})
