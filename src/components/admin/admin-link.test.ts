import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

describe('Admin links do not prefetch', () => {
  it('no Admin route imports next/link directly (use AdminLink, which defaults prefetch to false)', () => {
    const offenders = files('src/app/admin').filter((file) => /from ['"]next\/link['"]/.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })
  it('AdminLink defaults prefetch to false and lets callers override', () => {
    const source = readFileSync('src/components/admin/admin-link.tsx', 'utf8')
    expect(source).toContain('prefetch = false')
    expect(source).toContain('prefetch={prefetch}')
  })
})
