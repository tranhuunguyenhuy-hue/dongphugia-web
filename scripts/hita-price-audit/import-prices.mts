import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { validateInventory } from './batch-plan.mts'
import { applyPlan, planImport, rollbackLedger, type AdminClient, type LedgerEntry, type Product, type ResultRow } from './import-core.mts'

// #448 importer for the isolated TEST/Fixed Staging ONLY. Default mode is dry-run.
//   dry-run : npx tsx scripts/hita-price-audit/import-prices.mts --results prices.json --inventory inventory.json
//   apply   : ... --mode apply --ledger ledger.jsonl [--batch-size 10] [--max-writes N]
//   rollback: ... --mode rollback --ledger ledger.jsonl
// Credentials come from the environment only: CF_ACCESS_CLIENT_ID/SECRET (Access service token), DPG_E2E_EMAIL/PASSWORD (TEST admin).
const STAGING = 'https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev'
const { values } = parseArgs({ options: {
  mode: { type: 'string', default: 'dry-run' }, results: { type: 'string' }, inventory: { type: 'string' }, ledger: { type: 'string' },
  'category-id': { type: 'string', default: '4' }, 'batch-size': { type: 'string', default: '10' }, 'max-writes': { type: 'string' },
  'pause-ms': { type: 'string', default: '300' }, report: { type: 'string' }, base: { type: 'string', default: STAGING },
} })
if (values.base !== STAGING) throw new Error('REFUSED: only the Fixed Staging origin is allowed')
const need = (name: string) => { const v = process.env[name]; if (!v) throw new Error(`Missing env ${name}`); return v }
const headers = { 'User-Agent': 'dpg-price-import/1.0', 'CF-Access-Client-Id': need('CF_ACCESS_CLIENT_ID'), 'CF-Access-Client-Secret': need('CF_ACCESS_CLIENT_SECRET') }
async function http(method: string, path: string, body?: unknown, cookie?: string) {
  const response = await fetch(STAGING + path, { method, redirect: 'manual', signal: AbortSignal.timeout(30000),
    headers: { ...headers, Origin: STAGING, ...(cookie ? { Cookie: `dpg-admin-session=${cookie}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) })
  return { response, json: (await response.json().catch(() => ({}))) as { data?: unknown; error?: { code?: string } } }
}
const login = await http('POST', '/admin-next/api/login', { email: need('DPG_E2E_EMAIL'), password: need('DPG_E2E_PASSWORD') })
const cookie = /dpg-admin-session=([^;]+)/.exec(login.response.headers.get('set-cookie') ?? '')?.[1]
if (login.response.status !== 200 || !cookie) throw new Error(`LOGIN_FAILED_${login.response.status}`)
const client: AdminClient = {
  async get(id) { const r = await http('GET', `/admin-next/api/r/products/${id}`, undefined, cookie); if (r.response.status !== 200) throw new Error(`GET_${id}_${r.response.status}`); return r.json.data as Product },
  async patch(id, expectedVersion, input) { const r = await http('PATCH', `/admin-next/api/r/products/${id}`, { expected_version: expectedVersion, input }, cookie); return { status: r.response.status, code: r.json.error?.code } },
}
const inventory = validateInventory(JSON.parse(await readFile(values.inventory!, 'utf8')))
const categoryId = Number(values['category-id'])
const runId = new Date().toISOString().replace(/\W/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6)
const appendLedger = async (e: LedgerEntry) => { await mkdir(dirname(values.ledger!), { recursive: true }); await appendFile(values.ledger!, JSON.stringify(e) + '\n') }

if (values.mode === 'rollback') {
  const entries = (await readFile(values.ledger!, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l) as LedgerEntry)
  console.log(JSON.stringify({ mode: 'rollback', run_id: runId, ...(await rollbackLedger({ entries, client, runId, appendLedger })) }, null, 2))
} else {
  const rows = (JSON.parse(await readFile(values.results!, 'utf8')).rows ?? []) as ResultRow[]
  const items = await planImport({ rows, inventory, client, categoryId })
  const count = (k: string) => items.filter(i => i.kind === k).length
  const report = { mode: values.mode, run_id: runId, rows: rows.length, update: count('UPDATE'), noop: count('NOOP'), skip: count('SKIP'), quarantine: count('QUARANTINE'), refused: count('REFUSED'),
    changes: items.filter(i => i.kind === 'UPDATE').map(i => i.kind === 'UPDATE' && ({ id: i.id, sku: i.sku, changed: i.changed, before: i.before, after: i.after })),
    problems: items.filter(i => ['SKIP', 'QUARANTINE', 'REFUSED'].includes(i.kind)).map(i => ('reason' in i) && ({ id: i.id, sku: i.sku, kind: i.kind, reason: i.reason })) } as Record<string, unknown>
  if (values.mode === 'apply') {
    if (!values.ledger) throw new Error('--ledger is required for apply')
    report.result = await applyPlan({ items, client, runId, appendLedger, batchSize: Number(values['batch-size']), maxWrites: values['max-writes'] ? Number(values['max-writes']) : Infinity, pause: () => sleep(Number(values['pause-ms'])) })
  } else if (values.mode !== 'dry-run') throw new Error('--mode must be dry-run, apply or rollback')
  if (values.report) await writeFile(values.report, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  if ((report.result as { halted?: string | null } | undefined)?.halted) process.exitCode = 3
}
