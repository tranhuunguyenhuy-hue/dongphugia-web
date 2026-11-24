import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { parseCsv } from './quality-gate-core.mts'
import { buildReviewRows, toCsv, type SourceResult } from './review-report.mts'
import { parserVersion } from './adapter.mts'
import type { CrawlResult } from './crawl-engine.mts'

const [baselinePath, inventoryPath, output, ...inputs] = process.argv.slice(2)
assert(baselinePath && inventoryPath && output && inputs.length, 'usage: inax-recovery-export.mts <baseline.csv> <inventory.json> <output> <batch prices.json> [...]')
const baselineSha = '9e4733bc55ec87cd52642482a4a1904c8aace04b'
const baselineChecksum = 'aa0a93553ce5cf32c86e84f9e4aa8cfee73f66631500781341e634d25aa17cfd'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const text = await readFile(baselinePath, 'utf8')
assert.equal(hash(text), baselineChecksum)
const [header, ...lines] = parseCsv(text)
const baseline = lines.map(cells => Object.fromEntries(header.map((key, i) => [key, cells[i]])))
const sanitary = baseline.filter(row => row.brand === 'INAX' && row.category === 'thiet-bi-ve-sinh')
const originalById = new Map(sanitary.map(r => [Number(r.dpg_id), r]))
const inventory = JSON.parse(await readFile(inventoryPath, 'utf8')) as { id: number; sku: string; category: string; is_active: boolean }[]
assert.equal(sanitary.length, 2090)
assert.equal(originalById.size, 2090)
assert.equal(inventory.length, 2090)
assert.equal(new Set(inventory.map(r => r.id)).size, 2090)
assert.equal(new Set(inventory.map(r => r.sku.toUpperCase())).size, 2090)
assert.equal(inventory.filter(r => r.is_active).length, 1653)
for (const row of inventory) {
  const original = originalById.get(row.id)
  assert(original && original.sku === row.sku && original.is_active === String(row.is_active) && original.category === row.category)
}

const batches = await Promise.all(inputs.map(async path => JSON.parse(await readFile(path, 'utf8')) as { summary: { halt_reason?: string | null }; rows: CrawlResult[] }))
const haltReason = batches.at(-1)?.summary.halt_reason
const newById = new Map<number, CrawlResult>()
for (const batch of batches) {
  for (const r of batch.rows) {
    const original = originalById.get(r.dpg_id)
    assert(original && original.sku === r.dpg_sku && original.is_active === String(r.is_active) && original.category === r.category)
    assert(!newById.has(r.dpg_id), `Duplicate crawl row ${r.dpg_id}`)
    assert.equal(r.parser_version, parserVersion)
    assert.equal(r.expected_brand, 'INAX')
    newById.set(r.dpg_id, r)
  }
}

const recovery = sanitary.filter(r => r.status !== 'EXACT')
const kept = sanitary.filter(r => r.status === 'EXACT')
assert.equal(recovery.length, 1543)
assert.equal(kept.length, 547)
const recoveryRows = recovery.map(original => {
  const id = Number(original.dpg_id)
  const latest = newById.get(id)
  const inv = { id, sku: original.sku, name: original.product_name, is_active: original.is_active === 'true' }
  const fresh = latest ? new Map([[id, latest as SourceResult]]) : new Map()
  const [row] = buildReviewRows([inv], fresh, new Map(), { pilotLabel: '', blockedReason: null, blockedAtUtc: null })
  if (!latest) {
    row.status = 'NOT_CRAWLED'
    row.reason = haltReason ? `PENDING_${haltReason}` : 'PENDING'
    row.review_status = 'NOT_CRAWLED_PENDING'
  } else if (row.status === 'UNKNOWN') row.review_status = 'UNKNOWN_TECHNICAL'
  return { ...original, ...row, brand: 'INAX',
    discount_percent_computed: typeof row.regular_price_vnd === 'number' && typeof row.promotional_price_vnd === 'number'
      ? Math.round((1 - row.promotional_price_vnd / row.regular_price_vnd) * 100) : '',
    parser_version: latest?.parser_version ?? '', price_source: latest ? 'HITA_RECOVERY_477' : '',
    baseline_status: original.status, baseline_reason: original.reason, lookup_url: latest?.source_url ?? '',
  }
})
const baselineRows = kept.map(r => ({ ...r, dpg_id: r.dpg_id, parser_version: 'baseline-448',
  review_status: 'STALE_PILOT_BASELINE_448', price_source: 'HITA_BASELINE_448', baseline_status: r.status, baseline_reason: r.reason, lookup_url: r.hita_url }))
const merged = [...baselineRows, ...recoveryRows].sort((a, b) => Number(a.dpg_id) - Number(b.dpg_id))
const exceptions = recoveryRows.filter(r => r.status !== 'EXACT' || r.reason)
const aliases = recoveryRows.filter(r => r.status === 'AMBIGUOUS').map(r => ({
  dpg_id: r.dpg_id, sku: r.sku, reason: r.reason, lookup_url: r.lookup_url,
  candidates: newById.get(Number(r.dpg_id))?.search_candidates.join(' | ') ?? '',
}))
const evidence = recoveryRows.flatMap(r => {
  const result = newById.get(Number(r.dpg_id))
  return result ? [JSON.stringify(result)] : []
}).join('\n')
const columns = [...header, 'parser_version', 'price_source', 'baseline_status', 'baseline_reason', 'lookup_url']
const files = {
  'recovery.csv': toCsv(columns, recoveryRows),
  'sanitary-merged.csv': toCsv(columns, merged),
  'exceptions.csv': toCsv(['dpg_id', 'sku', 'category', 'is_active', 'hita_url', 'lookup_url', 'source_checked_at_utc', 'status', 'reason', 'parser_version'], exceptions),
  'ambiguous-aliases.csv': toCsv(['dpg_id', 'sku', 'reason', 'lookup_url', 'candidates'], aliases),
  'evidence.jsonl': evidence ? evidence + '\n' : '',
}
await mkdir(output, { recursive: true })
for (const [name, content] of Object.entries(files)) await writeFile(join(output, name), content.replaceAll('\r\n', '\n'))
const by = (rows: typeof recoveryRows, get: (row: (typeof recoveryRows)[number]) => string) =>
  Object.fromEntries([...new Set(rows.map(get))].sort().map(key => [key, rows.filter(r => get(r) === key).length]))
const priced = recoveryRows.filter(r => r.status === 'EXACT')
const summary = {
  baselineSha, baselineChecksum, outOfScope: baseline.length - sanitary.length, excludedOutOfScopeExceptions: baseline.filter(r => r.category !== 'thiet-bi-ve-sinh' && r.status !== 'EXACT').length,
  inventoryRows: inventory.length, active: 1653, baselinePrices: kept.length, inventoryMismatchToBaseline: 0,
  targets: recoveryRows.length, checked: recoveryRows.filter(r => r.status !== 'NOT_CRAWLED').length,
  priced: priced.length, pricedActive: priced.filter(r => r.is_active).length, pricedInactive: priced.filter(r => !r.is_active).length,
  priceFields: by(priced, r => String([r.regular_price_vnd, r.promotional_price_vnd, r.online_voucher_amount_vnd].filter(Boolean).length)),
  voucher: priced.filter(r => r.online_voucher_amount_vnd).length, status: by(recoveryRows, r => String(r.status)),
  exceptions: by(exceptions, r => String(r.reason)), batches: batches.map(b => b.summary),
  checksums: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, hash(content.replaceAll('\r\n', '\n'))])),
}
await writeFile(join(output, 'crawl-summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
