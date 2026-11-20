import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ALLOWED_REPOSITORIES,
  currentRepository,
  isAllowedRepository,
  isAllowedWorkflowRef,
} from '../lib/repository-identity.mjs'

const CURRENT = 'tranhuunguyenhuy-hue/dongphugia-web'
const RETIRED = 'tranhuunguyenhuy-hue/dongphugia.com.vn'

describe('repository identity (renamed to dongphugia-web, #426)', () => {
  it('allows exactly the current repository', () => {
    expect([...ALLOWED_REPOSITORIES]).toEqual([CURRENT])
    expect(isAllowedRepository(CURRENT)).toBe(true)
  })

  it.each([
    RETIRED,
    'someone-else/dongphugia-web',
    'tranhuunguyenhuy-hue/dongphugia',
    'tranhuunguyenhuy-hue/dongphugia-web-fork',
    'tranhuunguyenhuy-hue/dongphugia-web/',
    'TRANHUUNGUYENHUY-HUE/DONGPHUGIA-WEB',
    '',
    undefined,
    null,
  ])('fails closed for %s', (value) => {
    expect(isAllowedRepository(value as string)).toBe(false)
  })

  it('accepts only exact main workflow refs of the current repository', () => {
    expect(isAllowedWorkflowRef(`${CURRENT}/.github/workflows/v1-fixed-preview.yml@refs/heads/main`, 'v1-fixed-preview.yml')).toBe(true)
    expect(isAllowedWorkflowRef(`${RETIRED}/.github/workflows/v1-fixed-preview.yml@refs/heads/main`, 'v1-fixed-preview.yml')).toBe(false)
    expect(isAllowedWorkflowRef(`${CURRENT}/.github/workflows/v1-fixed-preview.yml@refs/heads/feature`, 'v1-fixed-preview.yml')).toBe(false)
    expect(isAllowedWorkflowRef(`${CURRENT}/.github/workflows/other.yml@refs/heads/main`, 'v1-fixed-preview.yml')).toBe(false)
  })

  it('self-references the current identity and throws for anything else', () => {
    expect(currentRepository({ GITHUB_REPOSITORY: CURRENT })).toBe(CURRENT)
    expect(currentRepository({})).toBe(CURRENT)
    expect(() => currentRepository({ GITHUB_REPOSITORY: RETIRED })).toThrow('REPOSITORY_IDENTITY_INVALID')
    expect(() => currentRepository({ GITHUB_REPOSITORY: 'attacker/dongphugia-web' })).toThrow('REPOSITORY_IDENTITY_INVALID')
  })
})

describe('workflow repository guards', () => {
  const dir = join(process.cwd(), '.github/workflows')
  const files = readdirSync(dir).filter((name) => name.endsWith('.yml'))

  it('pin only the current name; no retired name, list or wildcard', () => {
    let guarded = 0
    for (const name of files) {
      const text = readFileSync(join(dir, name), 'utf8')
      expect(text, name).not.toContain(RETIRED)
      expect(text, name).not.toMatch(/fromJSON\('\["tranhuunguyenhuy-hue/)
      expect(text, name).not.toMatch(/startsWith\(github\.repository/)
      if (text.includes(`github.repository == '${CURRENT}'`)) guarded += 1
    }
    expect(guarded).toBeGreaterThanOrEqual(13)
  })
})
