import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { planScope, validateInventory } from './batch-plan.mts'
import { checkRobots, politeFetch, runBatch, type CrawlResult } from './crawl-engine.mts'
import { desiredPrices } from './pricing-policy.mts'

// #448 batch crawler: Hita public pages, EXACT SKU only, polite (1 req/s), checkpointed and resumable.
//   npx tsx scripts/hita-price-audit/batch.mts --inventory <inventory.json> --output <dir> [--limit N] [--ttl-hours 6]
const { values } = parseArgs({ options: {
  inventory: { type: 'string' }, output: { type: 'string', default: 'hita-batch-output' },
  limit: { type: 'string', default: '1000' }, offset: { type: 'string', default: '0' }, reverse: { type: 'boolean', default: false }, 'ttl-hours': { type: 'string', default: '6' }, 'min-interval-ms': { type: 'string', default: '1000' }, 'request-budget': { type: 'string' },
} })
if (!values.inventory) throw new Error('--inventory is required')
const scope = planScope(validateInventory(JSON.parse(await readFile(values.inventory, 'utf8'))))
await mkdir(values.output, { recursive: true })
const checkpointPath = join(values.output, 'checkpoint.jsonl')
const previous = new Map<number, CrawlResult>()
try { for (const line of (await readFile(checkpointPath, 'utf8')).split('\n').filter(Boolean)) { const r = JSON.parse(line) as CrawlResult; previous.set(r.dpg_id, r) } } catch { /* first run */ }

// A slice of the crawl scope (stable order by DPG id, optionally reversed) so independent runs cover disjoint ranges.
const ordered = values.reverse ? [...scope.toCrawl].reverse() : scope.toCrawl
const slice = ordered.slice(Number(values.offset), Number(values.offset) + Number(values.limit))
const requestLog: unknown[] = []  // sanitized: path, status, duration only
const startedAt = new Date().toISOString()
const minIntervalMs = Number(values['min-interval-ms'])
const requestBudget = values['request-budget'] === undefined ? Infinity : Number(values['request-budget'])
if (!Number.isFinite(minIntervalMs) || minIntervalMs < 1000) throw new Error('MIN_INTERVAL_BELOW_1S')
if (requestBudget !== Infinity && (!Number.isSafeInteger(requestBudget) || requestBudget < 1)) throw new Error('INVALID_REQUEST_BUDGET')
const fetchText = politeFetch({ minIntervalMs, requestBudget, log: entry => requestLog.push(entry) })
const robotsStop = await checkRobots(fetchText)
const run = robotsStop ? { results: [] as CrawlResult[], crawled: 0, reused: 0, haltReason: robotsStop, remaining: slice.length } : await runBatch({
  rows: slice, previous, ttlMs: Number(values['ttl-hours']) * 3600_000,
  fetchText,
  onResult: async (result, reused) => { if (!reused) await appendFile(checkpointPath, JSON.stringify(result) + '\n') },
})
const rows = run.results
const decisions = rows.map(row => ({ row, desired: desiredPrices(row) }))
const exceptions = [
  ...scope.skipped.map(r => ({ dpg_id: r.id, sku: r.sku, category: 'thiet-bi-ve-sinh', url: null, timestamp_utc: null, reason: 'SYNTHETIC_FIXTURE' })),
  ...decisions.filter(d => d.row.status !== 'EXACT' || d.row.exception).map(d => ({ dpg_id: d.row.dpg_id, sku: d.row.dpg_sku, category: d.row.category,
    url: d.row.source_url, timestamp_utc: d.row.retrieved_at_utc, reason: d.row.status === 'EXACT' ? String(d.row.exception) : d.row.status + (d.row.exception ? `:${d.row.exception}` : '') })),
]
const count = (f: (r: CrawlResult) => boolean) => rows.filter(f).length
const summary = {
  started_at_utc: startedAt, completed_at_utc: new Date().toISOString(), inventory_total: scope.total, synthetic_skipped: scope.skipped.length,
  crawl_scope: scope.toCrawl.length, crawled_now: run.crawled, reused_from_checkpoint: run.reused, remaining: run.remaining, halt_reason: run.haltReason,
  by_status: Object.fromEntries(['EXACT', 'CONTACT', 'DISCONTINUED', 'NOT_FOUND', 'AMBIGUOUS', 'BLOCKED', 'UNKNOWN'].map(s => [s, count(r => r.status === s)])),
  exact_with_three_prices: count(r => r.status === 'EXACT' && r.promotional_price_vnd !== null && r.online_voucher_amount_vnd !== null),
  exact_with_regular_and_promotional: count(r => r.status === 'EXACT' && r.promotional_price_vnd !== null),
  exact_with_regular_only: count(r => r.status === 'EXACT' && r.promotional_price_vnd === null),
  exact_with_voucher: count(r => r.status === 'EXACT' && r.online_voucher_amount_vnd !== null),
  quarantined: decisions.filter(d => d.desired.action === 'QUARANTINE').length,
  requests: requestLog.length, requests_non_2xx: requestLog.filter(e => { const status = (e as { status: number | null }).status; return !(status !== null && status >= 200 && status < 300) }).length,
}
await writeFile(join(values.output, 'prices.json'), JSON.stringify({ summary, rows }, null, 2) + '\n')
await writeFile(join(values.output, 'exceptions.json'), JSON.stringify(exceptions, null, 2) + '\n')
const cell = (v: unknown) => '"' + String(v ?? '').replaceAll('"', '""') + '"'
await writeFile(join(values.output, 'exceptions.csv'), ['dpg_id,sku,category,url,timestamp_utc,reason', ...exceptions.map(e => Object.values(e).map(cell).join(','))].join('\n') + '\n')
console.log(JSON.stringify(summary, null, 2))
if (run.haltReason && run.haltReason !== 'LIMIT_REACHED') process.exitCode = 2
