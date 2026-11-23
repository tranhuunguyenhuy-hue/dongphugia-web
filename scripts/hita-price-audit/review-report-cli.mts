import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { validateInventory } from './batch-plan.mts'
import { buildReviewRows, exceptionRows, EXCEPTION_COLUMNS, REVIEW_COLUMNS, summaryMarkdown, toCsv, type NamedInventoryRow, type SourceResult } from './review-report.mts'

// npx tsx scripts/hita-price-audit/review-report-cli.mts --inventory inv.json --live <batch output dir> --pilot sample/prices.json \
//   --pilot-label STALE_PILOT_2026-11-22 --prod-total 16447 --prod-active 5344 --prod-distinct 16447 --prod-checked-at <UTC> --output <dir>
const { values } = parseArgs({ options: {
  inventory: { type: 'string' }, live: { type: 'string' }, pilot: { type: 'string' }, 'pilot-label': { type: 'string', default: 'STALE_PILOT' }, output: { type: 'string' },
  'prod-total': { type: 'string' }, 'prod-active': { type: 'string' }, 'prod-distinct': { type: 'string' }, 'prod-checked-at': { type: 'string' },
} })
for (const k of ['inventory', 'live', 'pilot', 'output', 'prod-total', 'prod-active', 'prod-distinct', 'prod-checked-at'] as const) if (!values[k]) throw new Error(`--${k} is required`)
const inventory = validateInventory(JSON.parse(await readFile(values.inventory!, 'utf8'))) as NamedInventoryRow[]
const read = async (p: string) => JSON.parse(await readFile(p, 'utf8'))
const toMap = (rows: Array<Record<string, unknown>>) => new Map((rows ?? []).map(r => [Number(r.dpg_id), r as unknown as SourceResult]))
const live = await read(join(values.live!, 'prices.json'))
const pilot = await read(values.pilot!)
const reqs = Number(live.summary.requests), non2xx = Number(live.summary.requests_non_2xx)
const rows = buildReviewRows(inventory, toMap(live.rows), toMap(pilot.rows), {
  pilotLabel: values['pilot-label']!, blockedReason: live.summary.halt_reason ? `LIVE_BLOCKED:${live.summary.halt_reason}` : null, blockedAtUtc: live.summary.completed_at_utc })
await mkdir(values.output!, { recursive: true })
const files = ['hita_prices_review.csv', 'hita_exceptions.csv', 'hita_crawl_summary.md']
await writeFile(join(values.output!, files[0]), toCsv(REVIEW_COLUMNS, rows))
await writeFile(join(values.output!, files[1]), toCsv(EXCEPTION_COLUMNS, exceptionRows(rows)))
await writeFile(join(values.output!, files[2]), summaryMarkdown({ rows, files,
  scope: { inventoryTotal: inventory.length, synthetic: inventory.length - rows.length },
  coverage: { prodTotal: Number(values['prod-total']), prodActive: Number(values['prod-active']), prodDistinct: Number(values['prod-distinct']), prodCheckedAtUtc: values['prod-checked-at']! },
  attempt: { startedAtUtc: live.summary.started_at_utc, httpRequests: reqs, non2xx, haltReason: live.summary.halt_reason, firstStatus: live.summary.halt_reason?.startsWith('HTTP_') ? Number(/^HTTP_(\d+)/.exec(live.summary.halt_reason)?.[1]) : null } }))
console.log(JSON.stringify({ rows: rows.length, files }))
