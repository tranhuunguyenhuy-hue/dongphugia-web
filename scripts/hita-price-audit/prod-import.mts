import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { applySql, buildPlan, releaseBindingMatches, ledgerJsonl, rollbackSql, SNAPSHOT_SQL, type DbRow } from './prod-import-core.mts'
import type { InvRow } from './quality-gate-core.mts'

// #470 Step 3b. DRY-RUN BY DEFAULT and WRITE-INCAPABLE: this tool never opens a database connection.
//   npx tsx scripts/hita-price-audit/prod-import.mts <prices.csv> --csv-sha256 <hex64> --candidate-sha <git sha40> \
//     --inventory inv.json [--inventory inv2.json] --db-snapshot snapshot.json [--now ISO] [--batch-size 200] [--include-inactive] \
//     [--out dir]   (writes apply/rollback SQL batches, ledger.jsonl and manifest.json; nothing is executed)
//     [--go-token candidate:csv:plan]   (only checks that the text quoted in the Owner GO identifies this plan; executes nothing)
// snapshot.json = { "db_size_bytes": number, "rows": [DbRow...] } produced read-only with the SNAPSHOT_SQL printed by --print-snapshot-sql.
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  'csv-sha256': { type: 'string' }, 'candidate-sha': { type: 'string' }, inventory: { type: 'string', multiple: true, default: [] }, 'db-snapshot': { type: 'string' },
  now: { type: 'string' }, 'batch-size': { type: 'string' }, 'include-inactive': { type: 'boolean', default: false }, out: { type: 'string' }, 'go-token': { type: 'string' }, 'print-snapshot-sql': { type: 'boolean', default: false },
} })
if (values['print-snapshot-sql']) { console.log(SNAPSHOT_SQL); process.exit(0) }
if (positionals.length !== 1 || !values['db-snapshot'] || !values.inventory.length) { console.error('usage: prod-import.mts <prices.csv> --csv-sha256 H --candidate-sha S --inventory inv.json --db-snapshot snap.json [--out dir]'); process.exit(2) }
const csvText = await readFile(positionals[0], 'utf8')
const inventory: InvRow[] = (await Promise.all(values.inventory.map(async f => JSON.parse(await readFile(f, 'utf8')) as InvRow[]))).flat()
const snap = JSON.parse(await readFile(values['db-snapshot'], 'utf8')) as { db_size_bytes: number; rows: DbRow[] }
const plan = buildPlan({
  csvText, expectedCsvSha256: values['csv-sha256'] ?? '', candidateSha: values['candidate-sha'] ?? '', inventory, db: snap.rows, dbSizeBytes: snap.db_size_bytes,
  now: values.now ? new Date(values.now) : new Date(), batchSize: values['batch-size'] ? Number(values['batch-size']) : undefined, activeOnly: !values['include-inactive'],
})
const report = { mode: values.out ? 'emit-sql (nothing executed)' : 'dry-run', plan_sha: plan.planSha, csv_sha256: plan.csvSha256, candidate_sha: plan.candidateSha, release_binding: plan.releaseBinding, release_binding_note: 'identity for the manifest only; execution needs the Owner GO',
  release_binding_matches: values['go-token'] === undefined ? null : releaseBindingMatches(plan, values['go-token']), stop_reasons: plan.stopReasons, ...plan.summary }
if (values.out && !plan.stopReasons.length) {
  await mkdir(values.out, { recursive: true })
  for (let i = 0; i < plan.batches.length; i++) {
    const n = String(i + 1).padStart(4, '0')
    await writeFile(join(values.out, `batch-${n}-apply.sql`), applySql(plan, i))
    await writeFile(join(values.out, `batch-${n}-rollback.sql`), rollbackSql(plan, i))
  }
  await writeFile(join(values.out, 'ledger.jsonl'), ledgerJsonl(plan))
  await writeFile(join(values.out, 'manifest.json'), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))
if (plan.stopReasons.length) process.exitCode = 1
