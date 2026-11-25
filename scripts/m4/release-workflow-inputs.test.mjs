import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// #470: GitHub's workflow YAML parser reads an unquoted `on` as the boolean true, so `options: [off, on]` made the value `on` impossible to
// dispatch (the picker only accepted `true`, which the configure scripts reject). The flags that turn pricing/commerce ON must stay dispatchable.
describe('#470 M4 release lane flag inputs', () => {
  const workflow = readFileSync('.github/workflows/m4-production-admin-release.yml', 'utf8')
  it('declares the off/on options as quoted strings (never bare on/off)', () => {
    const lists = [...workflow.matchAll(/^\s+options: \[(.*)\]\s*$/gm)].map((m) => m[1].trim())
    const flagLists = lists.filter((l) => /\bon\b/i.test(l) && /\boff\b/i.test(l))
    expect(flagLists).toHaveLength(2)
    for (const list of flagLists) expect(list).toBe("'off', 'on'")
  })
  it('keeps the quoted string defaults', () => {
    expect([...workflow.matchAll(/^\s+default: 'off'\s*$/gm)]).toHaveLength(2)
  })
})
