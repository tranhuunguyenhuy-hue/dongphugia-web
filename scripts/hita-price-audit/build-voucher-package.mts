// #470 — builds the supplementary voucher package (docs/ops/price-release-470/voucher-lane) from the Codex package #485 evidence. Deterministic; run: npx tsx scripts/hita-price-audit/build-voucher-package.mts
// Pins every voucher whose stored evidence is acceptable: HITA_ONLY_TERMS rows (Owner policy 24/11: DPG accepts the Hita exact-SKU voucher), priced by lane A/B/C, amount > 0 and below the selling price.
// Held NULL: the 29 Owner-requested TOTO rows and the 2 INAX rows whose promotion is held (their selling price is not confirmed). No advertising text is copied.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseCsv } from './quality-gate-core.mts'
import { sha256 } from './prod-import-core.mts'

const root = path.resolve(import.meta.dirname, '../../docs/ops/hita-448/owner-accepted-candidates'), out = path.resolve(import.meta.dirname, '../../docs/ops/price-release-470/voucher-lane')
const rowsOf = (f: string) => { const t = parseCsv(readFileSync(path.join(root, f), 'utf8')), h = t[0].map(x => x.trim()); return t.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i] ?? '']))) }
const price = new Map<number, { regular: number; promo: number | null; sku: string }>()
for (const c of ['toto-active', 'toto-inactive', 'inax-active', 'inax-inactive']) for (const r of rowsOf(`${c}/archived-direct.csv`)) price.set(Number(r.dpg_id), { regular: Number(r.regular_price_vnd), promo: r.promotional_price_vnd ? Number(r.promotional_price_vnd) : null, sku: r.sku })
for (const r of rowsOf('inax-active/inax-baseline-hold.csv')) price.set(Number(r.dpg_id), { regular: Number(r.proposed_regular_price_vnd), promo: r.proposed_promotional_price_vnd ? Number(r.proposed_promotional_price_vnd) : null, sku: r.sku })
const holds = rowsOf('voucher-holds.csv'), approved: Record<string, string>[] = [], heldNull: number[] = []
for (const r of holds) {
  const id = Number(r.dpg_id), p = price.get(id), amount = Number(r.original_voucher_vnd)
  if (r.reason !== 'HITA_ONLY_TERMS_NO_DPG_APPROVAL') { heldNull.push(id); continue }
  if (!p || p.sku !== r.sku || !Number.isSafeInteger(amount) || amount < 1) continue
  if (r.brand === 'INAX' && p.promo === null) { heldNull.push(id); continue }                      // the 2 promotion-held INAX rows (selling price unconfirmed)
  if (amount >= (p.promo ?? p.regular)) continue
  approved.push({ brand: r.brand, dpg_id: r.dpg_id, sku: r.sku, is_active: r.is_active, voucher_vnd: String(amount), source_checked_at_utc: r.source_checked_at_utc, source_url: r.source_url })
}
approved.sort((a, b) => Number(a.dpg_id) - Number(b.dpg_id)); heldNull.sort((a, b) => a - b)
const cols = ['brand', 'dpg_id', 'sku', 'is_active', 'voucher_vnd', 'source_checked_at_utc', 'source_url']
const q = (v: string) => `"${v.replaceAll('"', '""')}"`
const csv = '﻿' + [cols.map(q).join(','), ...approved.map(r => cols.map(c => q(r[c])).join(','))].join('\n') + '\n'
writeFileSync(path.join(out, 'voucher-approved.csv'), csv)
const approval = { approved_by: 'Owner', approval_ref: 'https://github.com/tranhuunguyenhuy-hue/dongphugia-web/issues/470#issuecomment-7128797116', rule_ref: 'https://github.com/tranhuunguyenhuy-hue/dongphugia-web/issues/443#issuecomment-7128795600',
  csv_sha256: sha256(csv), approved_ids: approved.map(r => Number(r.dpg_id)), hold_null_ids: heldNull, production_go: false }
writeFileSync(path.join(out, 'voucher-approval.json'), JSON.stringify(approval, null, 1) + '\n')
const by = (b: string) => approved.filter(r => r.brand === b).length
console.log(JSON.stringify({ approved: approved.length, toto: by('TOTO'), inax: by('INAX'), held_null: heldNull.length, csv_sha256: approval.csv_sha256 }))
