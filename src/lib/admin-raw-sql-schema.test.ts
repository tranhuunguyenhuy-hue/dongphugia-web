import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Prisma qualifies typed queries with the dpg_app schema, but raw SQL runs with the connection's
// default search_path (the least-privilege Admin role does not have dpg_app on it). An unqualified
// table made /admin/content/banners fail with P2010 on the M3 Preview. Keep every Admin raw statement
// schema-qualified.
const FILES = [
  'src/app/admin/(dashboard)/content/banners/page.tsx',
  'src/lib/admin-dashboard-queries.ts',
  'src/lib/blog-actions.ts',
]
const TABLE_REFERENCE = /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?!dpg_app\.)([a-z_][a-z0-9_]*)\b/g
const SQL_KEYWORDS = new Set(['select', 'set', 'where', 'values', 'only'])

describe('Admin raw SQL schema qualification', () => {
  for (const file of FILES) {
    it(`${file} qualifies every table with dpg_app`, () => {
      const source = readFileSync(file, 'utf8')
      const unqualified = [...source.matchAll(TABLE_REFERENCE)]
        .map((match) => match[1])
        .filter((name) => !SQL_KEYWORDS.has(name.toLowerCase()))
      // Only statements inside raw SQL blocks matter; TypeScript `import ... from '...'` has a quote, not [a-z_].
      expect(unqualified).toEqual([])
    })
  }
})
