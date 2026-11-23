import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { buildRows, CLAUDE_COLUMNS, CLAUDE_EXCEPTION_COLUMNS, exceptionsOf, latestByProduct, summary, toCsv, type Crawled, type Inv, type RunInfo } from './parallel-report.mts'

// npx tsx scripts/hita-price-audit/parallel-report-cli.mts --inventory inv.json --runs dirA,dirB --run-labels "A,B" --run-envs "GitHub-hosted runner,..." --output docs/ops/hita-claude ...
const { values } = parseArgs({ options: {
  inventory: { type: 'string' }, runs: { type: 'string' }, 'run-labels': { type: 'string' }, 'run-envs': { type: 'string' }, output: { type: 'string' }, method: { type: 'string', default: 'CLAUDE_CRAWL' },
  brand: { type: 'string', default: 'TOTO' }, 'prod-sanitary': { type: 'string' }, 'prod-brand-total': { type: 'string' }, 'prod-brand-active': { type: 'string' }, 'checked-at': { type: 'string' }, probe: { type: 'string', multiple: true, default: [] },
} })
for (const k of ['inventory', 'runs', 'output', 'prod-sanitary', 'prod-brand-total', 'prod-brand-active', 'checked-at'] as const) if (!values[k]) throw new Error(`--${k} is required`)
const inventory = JSON.parse(await readFile(values.inventory!, 'utf8')) as Inv[]
const dirs = values.runs!.split(','), labels = (values['run-labels'] ?? '').split(','), envs = (values['run-envs'] ?? '').split(',')
const results: Crawled[] = [], runs: RunInfo[] = []
for (const [i, dir] of dirs.entries()) {
  const lines = (await readFile(join(dir, 'checkpoint.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
  results.push(...lines.map(l => JSON.parse(l) as Crawled))
  const s = JSON.parse(await readFile(join(dir, 'prices.json'), 'utf8')).summary
  runs.push({ label: labels[i] ?? `run-${i + 1}`, environment: envs[i] ?? 'unknown', startedAtUtc: s.started_at_utc, requests: s.requests, non2xx: s.requests_non_2xx, haltReason: s.halt_reason === 'LIMIT_REACHED' ? null : s.halt_reason, crawled: s.crawled_now + s.reused_from_checkpoint })
}
const rows = buildRows(inventory, results, values.method!)
await mkdir(values.output!, { recursive: true })
await writeFile(join(values.output!, 'claude_hita_prices_review.csv'), toCsv(CLAUDE_COLUMNS, rows))
await writeFile(join(values.output!, 'claude_hita_exceptions.csv'), toCsv(CLAUDE_EXCEPTION_COLUMNS, exceptionsOf(rows)))
await writeFile(join(values.output!, 'claude_hita_checkpoint.jsonl'), [...latestByProduct(results).values()].sort((a, b) => a.dpg_id - b.dpg_id).map(r => JSON.stringify(r)).join('\n') + '\n')
await writeFile(join(values.output!, 'claude_hita_summary.md'), summary(rows, { brand: values.brand!, prodSanitary: Number(values['prod-sanitary']), prodBrandTotal: Number(values['prod-brand-total']), prodBrandActive: Number(values['prod-brand-active']), checkedAtUtc: values['checked-at']!, runs, probes: values.probe ?? [] }))
const visited = rows.filter(r => r.status !== 'NOT_CRAWLED').length
console.log(JSON.stringify({ rows: rows.length, visited, exact: rows.filter(r => r.status === 'EXACT').length }))
