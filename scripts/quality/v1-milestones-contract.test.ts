import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const getDoc = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')
const agents = getDoc('AGENTS.md')
const handbook = getDoc('docs/PROJECT.md')
const current = getDoc('docs/ops/project-current-state.md')
const claude = getDoc('CLAUDE.md')
const prodDb = getDoc('docs/deploy/postgresql-production-adoption-contract.md')
const cloudflare = getDoc('docs/deploy/cloudflare-fixed-preview-production.md')

describe('V1 post-M5 agent delivery authority', () => {
  it('uses one shared policy with issue-scoped authority and preserves PostgreSQL Public reads and rollback', () => {
    for (const v of [
      '#306',
      'POST-M5 / ACTIVE DEVELOPMENT',
      'Work only on the issue assigned to you',
      'agent-task.md',
      'serialized',
    ]) {
      expect(agents).toContain(v)
    }
    expect(prodDb).toContain('Public database read path')
    expect(prodDb).toContain('snapshot')
    expect(prodDb).toContain('read-only')
    expect(handbook).toContain('#311')
    expect(current).toContain('Merged vs deployed')
    expect(claude.trim()).toBe('@AGENTS.md')
  })

  it('uses one fixed named Preview inside Production Worker with isolated Admin', () => {
    expect(cloudflare).toContain('Preview `staging`')
    expect(cloudflare).toContain('dongphugia-v1-public-production')
    expect(cloudflare).toContain('Hyperdrive')
    expect(cloudflare).toContain('separate TEST PostgreSQL')
    expect(agents).toContain('Fixed Preview `staging`')
    expect(agents).toContain('No per-branch Preview, separate staging Worker or new domain')
    expect(agents).toContain('Access plus app Auth')
  })

  it('preserves data security, evidence and cancellation of old plans', () => {
    expect(agents).toContain('Never touch V2')
    expect(agents).toContain('No destructive data loss')
    expect(handbook).toContain('backup')
    expect(handbook).toContain('deploy/supabase-runtime-security-boundary.md')
    expect(current).toContain('tlmgudfhsyzayiazuugf')
  })
})
