import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ALLOWED_REPOSITORIES,
  currentRepository,
  isAllowedRepository,
  isAllowedWorkflowRef,
} from '../lib/repository-identity.mjs'

const OLD = 'tranhuunguyenhuy-hue/dongphugia.com.vn'
const NEW = 'tranhuunguyenhuy-hue/dongphugia-web'

describe('repository identity allowlist (#426 transitional)', () => {
  it('allows exactly the old and the new repository', () => {
    expect([...ALLOWED_REPOSITORIES]).toEqual([OLD, NEW])
    expect(isAllowedRepository(OLD)).toBe(true)
    expect(isAllowedRepository(NEW)).toBe(true)
  })

  it.each([
    'someone-else/dongphugia-web',
    'tranhuunguyenhuy-hue/dongphugia',
    'tranhuunguyenhuy-hue/dongphugia-web-fork',
    'tranhuunguyenhuy-hue/dongphugia.com.vn/',
    'TRANHUUNGUYENHUY-HUE/DONGPHUGIA-WEB',
    '',
    undefined,
    null,
  ])('fails closed for %s', (value) => {
    expect(isAllowedRepository(value as string)).toBe(false)
  })

  it('accepts only exact main workflow refs of an allowed repository', () => {
    for (const repo of [OLD, NEW]) {
      expect(isAllowedWorkflowRef(`${repo}/.github/workflows/v1-fixed-preview.yml@refs/heads/main`, 'v1-fixed-preview.yml')).toBe(true)
    }
    expect(isAllowedWorkflowRef(`${NEW}/.github/workflows/v1-fixed-preview.yml@refs/heads/feature`, 'v1-fixed-preview.yml')).toBe(false)
    expect(isAllowedWorkflowRef(`${NEW}/.github/workflows/other.yml@refs/heads/main`, 'v1-fixed-preview.yml')).toBe(false)
    expect(isAllowedWorkflowRef(`evil/dongphugia-web/.github/workflows/v1-fixed-preview.yml@refs/heads/main`, 'v1-fixed-preview.yml')).toBe(false)
  })

  it('self-references the current allowed identity and throws for anything else', () => {
    expect(currentRepository({ GITHUB_REPOSITORY: OLD })).toBe(OLD)
    expect(currentRepository({ GITHUB_REPOSITORY: NEW })).toBe(NEW)
    expect(currentRepository({})).toBe(OLD)
    expect(() => currentRepository({ GITHUB_REPOSITORY: 'attacker/dongphugia-web' })).toThrow('REPOSITORY_IDENTITY_INVALID')
  })
})

describe('workflow repository guards', () => {
  const dir = join(process.cwd(), '.github/workflows')
  const files = readdirSync(dir).filter((name) => name.endsWith('.yml'))

  it('never pin the old name alone and never use wildcards', () => {
    for (const name of files) {
      const text = readFileSync(join(dir, name), 'utf8')
      expect(text, name).not.toMatch(/github\.repository\s*==\s*'tranhuunguyenhuy-hue\/dongphugia\.com\.vn'/)
      expect(text, name).not.toMatch(/GITHUB_REPOSITORY"\s*=\s*'?tranhuunguyenhuy-hue\/dongphugia\.com\.vn'?\s*(\\|$)/m)
      expect(text, name).not.toMatch(/startsWith\(github\.repository/)
    }
  })

  it('keep the exact two-name guard where a repository check exists', () => {
    const guard = `contains(fromJSON('["${OLD}","${NEW}"]'), github.repository)`
    let guarded = 0
    for (const name of files) {
      const text = readFileSync(join(dir, name), 'utf8')
      if (text.replaceAll('${{ github.repository }}', '').includes('github.repository')) {
        expect(text, name).toContain(guard)
        guarded += 1
      }
    }
    expect(guarded).toBeGreaterThanOrEqual(13)
  })
})
