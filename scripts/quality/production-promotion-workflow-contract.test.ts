import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflowsDirectory = resolve(process.cwd(), '.github/workflows')
const workflowFiles = readdirSync(workflowsDirectory)
  .filter((file) => /\.(?:yml|yaml)$/.test(file))
  .map((file) => ({ file, source: readFileSync(resolve(workflowsDirectory, file), 'utf8') }))

function hasClosedPullRequestTrigger(source: string) {
  if (
    /(?:^|[,{])\s*["']?pull_request(?:_target)?["']?\s*:\s*\{[^{}]*\btypes\s*:\s*\[[^\]]*\bclosed\b[^\]]*\][^{}]*\}/s.test(
      source,
    )
  ) return true

  const lines = source.split(/\r?\n/)
  let pullRequestIndent = -1
  let typesIndent = -1
  let readingTypes = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (/^(?:pull_request|pull_request_target|['"]pull_request(?:_target)?['"]):\s*(?:#.*)?$/.test(trimmed)) {
      pullRequestIndent = indent
      typesIndent = -1
      readingTypes = false
      continue
    }
    if (/^(?:pull_request|pull_request_target):\s*\{[^}]*\bclosed\b[^}]*\}/.test(trimmed)) return true
    if (pullRequestIndent < 0) continue
    if (indent <= pullRequestIndent) {
      pullRequestIndent = -1
      typesIndent = -1
      readingTypes = false
      continue
    }
    const types = trimmed.match(/^types:\s*(.*)$/)
    if (types) {
      typesIndent = indent
      readingTypes = true
      if (/\bclosed\b/.test(types[1])) return true
      continue
    }
    if (readingTypes && indent > typesIndent && /^-\s*(?:closed|'closed'|"closed")\s*(?:#.*)?$/.test(trimmed)) return true
    if (readingTypes && indent <= typesIndent) readingTypes = false
  }
  return false
}

function reachesProductionPromotion(source: string) {
  return (
    source.includes('./.github/workflows/production-promotion.yml') ||
    source.includes('cloudflare/wrangler-action@') ||
    /\b(?:wrangler|pages)\s+deploy\b/.test(source)
  )
}

describe('Production promotion trigger guard (no merged-PR auto promotion)', () => {
  it('cannot promote from a merged pull-request trigger', () => {
    const automaticMergePromotionWorkflows = workflowFiles
      .filter(({ source }) => hasClosedPullRequestTrigger(source))
      .filter(({ source }) => reachesProductionPromotion(source))
      .map(({ file }) => file)

    expect(automaticMergePromotionWorkflows).toEqual([])
    expect(existsSync(resolve(workflowsDirectory, 'production-merge.yml'))).toBe(false)
  })

  it.each([
    ['plain block item', 'types:\n      - closed'],
    ['single-quoted block item', "types:\n      - 'closed'"],
    ['double-quoted block item', 'types:\n      - "closed"'],
    ['flow sequence', 'types: ["closed", opened]'],
    ['flow mapping with single quotes', "pull_request: { types: ['closed'] }"],
    ['pull_request_target flow mapping', 'pull_request_target: { types: ["closed", opened] }'],
    ['top-level flow on mapping', 'on: {pull_request: {types: [closed]}}'],
    ['quoted top-level flow keys', '"on": {"pull_request": {types: ["closed"]}}'],
  ])('detects %s merged-PR trigger syntax', (_label, trigger) => {
    const topLevelFlowOn = /^(?:on|'on'|"on")\s*:/.test(trigger)
    const event = trigger.startsWith('pull_request')
      ? trigger.replace(/\n/g, '\n  ')
      : 'pull_request:\n    ' + trigger
    const syntheticMergedPromotionWorkflow = `
${topLevelFlowOn ? trigger : 'on:\n  ' + event.replace(/\n/g, '\n  ')}
env:
  PRODUCTION_PROMOTION_ENABLED: true
jobs:
  promote:
    uses: ./.github/workflows/production-promotion.yml
    with:
      preview_artifact_name: dongphugia-preview-deadbeef
`
    expect(hasClosedPullRequestTrigger(syntheticMergedPromotionWorkflow)).toBe(true)
    expect(reachesProductionPromotion(syntheticMergedPromotionWorkflow)).toBe(true)
  })

  it.each([
    ['double-quoted pull_request key', 'on:\n  "pull_request":\n    types: [closed]'],
    ['single-quoted pull_request_target key', "on:\n  'pull_request_target':\n    types:\n      - closed"],
  ])('detects %s in a block-style event mapping', (_label, trigger) => {
    expect(hasClosedPullRequestTrigger(trigger)).toBe(true)
  })

  it('does not treat pull_request triggers without a closed activity type as merged triggers', () => {
    expect(hasClosedPullRequestTrigger('on:\n  pull_request:\n    branches: [main]')).toBe(false)
  })

  it('keeps the normal main quality path available', () => {
    const qualityWorkflow = workflowFiles.find(({ file }) => file === 'quality.yml')?.source ?? ''
    expect(qualityWorkflow).toContain('push:')
    expect(qualityWorkflow).toContain('- main')
  })

})
