import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { summarise, validate, type InvRow } from './quality-gate-core.mts'

// One command, re-runnable on any Codex CSV snapshot or later batch (no code change):
//   npx tsx scripts/hita-price-audit/quality-gate.mts <prices.csv> [--inventory inv.json] [--now ISO] [--max-age-hours 24] [--label text] [--issues-csv out.csv] [--json out.json]
// Exit code 1 when the file or any row has a hard FAIL. Reads files only: no network, no database.
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  inventory: { type: 'string', multiple: true, default: [] }, now: { type: 'string' }, 'max-age-hours': { type: 'string', default: '24' }, 'issues-csv': { type: 'string' }, json: { type: 'string' }, label: { type: 'string' },
} })
if (positionals.length !== 1) throw new Error('usage: quality-gate.mts <prices.csv> [options]')
const text = await readFile(positionals[0], 'utf8')
const inventory = new Map<number, InvRow>()
for (const file of values.inventory) for (const r of JSON.parse(await readFile(file, 'utf8')) as InvRow[]) inventory.set(r.id, { id: r.id, sku: r.sku, is_active: r.is_active })
const now = values.now ? new Date(values.now) : new Date()
if (Number.isNaN(now.getTime())) throw new Error('--now must be an ISO timestamp')
const result = validate(text, { now, maxAgeHours: Number(values['max-age-hours']), inventory: inventory.size ? inventory : undefined })
const summary = { file: values.label ?? positionals[0], sha256: createHash('sha256').update(text).digest('hex'), gate_run_at_utc: now.toISOString(), max_age_hours: Number(values['max-age-hours']), inventory_rows: inventory.size, ...summarise(result) }
if (values['issues-csv']) {
  const cell = (v: unknown) => '"' + String(v).replaceAll('"', '""') + '"'
  await writeFile(values['issues-csv'], '﻿line,dpg_id,sku,severity,code,detail\r\n' + result.issues.map(i => [i.line, i.dpg_id, i.sku, i.severity, i.code, i.detail].map(cell).join(',')).join('\r\n') + '\r\n')
}
if (values.json) await writeFile(values.json, JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
if (result.fileIssues.length || result.issues.some(i => i.severity === 'FAIL')) process.exitCode = 1
