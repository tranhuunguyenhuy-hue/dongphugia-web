// @vitest-environment node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateAdminResourceMigration } from './grants.ts'
import { RESOURCES } from './resources.ts'
import { slugify as appSlugify } from '../../../src/lib/utils.ts'
import { slugify } from './core.ts'
import { resourceBodySchemas, resourceQuerySchema } from './validation.ts'

const root = process.cwd()
const IDENT = /^[a-z_][a-z0-9_]*$/

describe('resource definitions', () => {
  it('only use safe static identifiers and consistent references', () => {
    const keys = new Set(RESOURCES.map((def) => def.key))
    expect(keys.size).toBe(RESOURCES.length)
    for (const def of RESOURCES) {
      expect(def.table).toMatch(IDENT)
      expect(new Set(def.fields.map((f) => f.name)).size, def.key).toBe(def.fields.length)
      for (const field of def.fields) {
        expect(field.name, def.key).toMatch(IDENT)
        if (field.kind === 'ref') expect(keys.has(field.ref!), `${def.key}.${field.name}`).toBe(true)
        if (field.kind === 'enum') expect(field.options?.length, `${def.key}.${field.name}`).toBeGreaterThan(0)
        if (field.required) expect(field.readOnly, `${def.key}.${field.name}`).toBeFalsy()
      }
      for (const column of def.search) expect(def.fields.some((f) => f.name === column), `${def.key} search ${column}`).toBe(true)
      expect(def.fields.some((f) => f.name === def.optionLabel), `${def.key} optionLabel`).toBe(true)
      for (const part of def.orderBy.split(',')) expect(part.trim(), def.key).toMatch(/^[a-z_][a-z0-9_]* (asc|desc)$/)
      for (const filter of def.filters ?? []) expect(def.fields.some((f) => f.name === filter.name), `${def.key} filter ${filter.name}`).toBe(true)
      for (const relation of def.relations ?? []) {
        for (const id of [relation.table, relation.owner, relation.target, relation.input]) expect(id).toMatch(IDENT)
        expect(keys.has(relation.ref)).toBe(true)
      }
      if (def.versioned) expect(def.fields.some((f) => f.name === 'version')).toBe(true)
      if (def.write) expect(def.read).toBeTruthy()
      // A writable resource never exposes a writable `id`, `version` or timestamp column.
      for (const field of def.fields) if (['id', 'version', 'created_at', 'updated_at'].includes(field.name)) expect(field.readOnly, `${def.key}.${field.name}`).toBe(true)
    }
  })

  it('keeps the committed migration and rollback in sync with the definitions', async () => {
    const guardSource = await readFile(path.join(root, 'supabase/m3-test/004_m3_test_admin_api.sql'), 'utf8')
    const guard = /-- guard:begin\n([\s\S]*?)-- guard:end/.exec(guardSource)![1]
    const { forward, rollback } = generateAdminResourceMigration(RESOURCES, {
      role: 'dpg_admin_api_test', policyPrefix: 'm3_admin_api_', guard, baseTables: [],
      title: 'M3 TEST-only (project uybumsnyqpwcidjxmfsv): column-level grants + RLS for the Admin resources served by `admin-api`.',
    })
    expect(await readFile(path.join(root, 'supabase/m3-test/005_m3_test_admin_resources.sql'), 'utf8')).toBe(forward)
    expect(await readFile(path.join(root, 'supabase/m3-test/005_m3_test_admin_resources_rollback.sql'), 'utf8')).toBe(rollback)
  })

  it('never grants price/identity/credential columns to the API role', async () => {
    const sql = await readFile(path.join(root, 'supabase/m3-test/005_m3_test_admin_resources.sql'), 'utf8')
    expect(sql).not.toMatch(/password_hash|\bprice\b|list_price|\bsku\b/)
    const writes = sql.split('\n').filter((line) => /^grant (insert|update) \(/.test(line))
    expect(writes.length).toBeGreaterThan(0)
    for (const line of writes) expect(line, line).not.toMatch(/\b(view_count|created_at|id)\b/)
    expect(sql).not.toMatch(/grant (all|delete) on dpg_app\.(blog_categories|blog_tags)\b/)
  })

  it('uses the same slug function as the application', () => {
    for (const text of ['Công ty ABC', 'Biệt thự Đà Lạt', 'Đường  -- Phố  ', 'Ốp lát & gạch 3D', '']) expect(slugify(text)).toBe(appSlugify(text))
  })

  it('builds strict schemas that reject unknown, read-only and mistyped input', () => {
    const posts = RESOURCES.find((def) => def.key === 'blog-posts')!
    const schemas = resourceBodySchemas(posts, ['media.example.test'])
    const ok = { input: { title: 'T', slug: 's', category_id: 1 } }
    expect(schemas.create.safeParse(ok).success).toBe(true)
    for (const bad of [{ input: { slug: 's', category_id: 1 } }, { input: { ...ok.input, version: 2 } }, { input: { ...ok.input, view_count: 1 } }, { input: { ...ok.input, category_id: '1' } }, { ...ok, extra: 1 }]) {
      expect(schemas.create.safeParse(bad).success).toBe(false)
    }
    expect(schemas.update.safeParse({ input: { title: 'x' } }).success).toBe(false) // version required for blog posts
    expect(schemas.update.safeParse({ expected_version: 1, input: {} }).success).toBe(false)
    expect(schemas.update.safeParse({ expected_version: 1, input: { seo_title: '   ' } }).data?.input.seo_title).toBeNull()
    const query = resourceQuerySchema(posts)
    expect(query.safeParse({ q: 'a', page: '2', status: 'draft' }).success).toBe(true)
    expect(query.safeParse({ limit: '51' }).success).toBe(false)
    expect(query.safeParse({ order: 'id' }).success).toBe(false)
  })
})
