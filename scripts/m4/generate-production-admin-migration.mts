// Regenerates the Production (M4) Admin migrations from the same resource definitions used for TEST. `--check` fails on drift.
import { writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
// The function sources are .ts files of a CommonJS package (no "type": "module"): read named exports through interop.
const interop = <T,>(module: T & { default?: T }): T => ((module as { default?: T }).default && !(Object.keys(module as object).length > 2) ? (module as { default: T }).default : module)
const { productionMigrationFiles } = interop(await import('../../supabase/functions/admin-api/production-migration.ts')) as typeof import('../../supabase/functions/admin-api/production-migration.ts')

const check = process.argv.includes('--check'); let drift = false
for (const [file, content] of productionMigrationFiles()) {
  const target = path.join(process.cwd(), file)
  if (check) { if ((await readFile(target, 'utf8').catch(() => '')) !== content) { console.error(`DRIFT ${file}`); drift = true } }
  else { await writeFile(target, content); console.log(`wrote ${file}`) }
}
if (drift) process.exit(1)
