// Regenerates supabase/m3-test/005_*.sql (+ rollback) from the Admin resource definitions. `--check` fails on drift.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
// The function sources are .ts files of a CommonJS package (no "type": "module"): read named exports through interop.
const interop = <T,>(module: T & { default?: T }): T => ((module as { default?: T }).default && !(Object.keys(module as object).length > 2) ? (module as { default: T }).default : module)
const { generateAdminResourceMigration } = interop(await import('../../supabase/functions/admin-api/grants.ts')) as typeof import('../../supabase/functions/admin-api/grants.ts')
const { RESOURCES } = interop(await import('../../supabase/functions/admin-api/resources.ts')) as typeof import('../../supabase/functions/admin-api/resources.ts')

const root = process.cwd()
const guardSource = await readFile(path.join(root, 'supabase/m3-test/004_m3_test_admin_api.sql'), 'utf8')
const guard = /-- guard:begin\n([\s\S]*?)-- guard:end/.exec(guardSource)?.[1]
if (!guard) throw new Error('GUARD_BLOCK_NOT_FOUND')

export const TEST_OPTIONS = {
  role: 'dpg_admin_api_test', policyPrefix: 'm3_admin_api_', guard, baseTables: [] as string[],
  title: 'M3 TEST-only (project uybumsnyqpwcidjxmfsv): column-level grants + RLS for the Admin resources served by `admin-api`.',
}
const { forward, rollback } = generateAdminResourceMigration(RESOURCES, TEST_OPTIONS)
const files = [
  ['supabase/m3-test/005_m3_test_admin_resources.sql', forward],
  ['supabase/m3-test/005_m3_test_admin_resources_rollback.sql', rollback],
] as const
const check = process.argv.includes('--check')
let drift = false
for (const [file, content] of files) {
  const target = path.join(root, file)
  if (check) {
    const current = await readFile(target, 'utf8').catch(() => '')
    if (current !== content) { console.error(`DRIFT ${file}`); drift = true }
  } else { await writeFile(target, content); console.log(`wrote ${file}`) }
}
if (drift) process.exit(1)
