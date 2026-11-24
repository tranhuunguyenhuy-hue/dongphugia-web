// #470 m6: generates scripts/m6/allowlist.json — the ONLY set of files and plans the Production SQL lane may touch. Every file is pinned by sha256; the lane
// refuses to run if any pinned file differs. `--check` fails on drift (CI test). There is no input that names a file, a path or SQL: the workflow chooses an
// operation/group from this table and nothing else.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const pin = (file) => ({ file, sha256: sha(file) })
const P = 'supabase/prod-prep/470', C = 'supabase/commerce-v1'
const OA = 'docs/ops/hita-448/owner-accepted-candidates', IH = 'docs/ops/hita-448/import-handoff', VL = 'docs/ops/price-release-470/voucher-lane'
const COHORTS = [['toto-active', 'toto', 'active'], ['toto-inactive', 'toto', 'inactive'], ['inax-active', 'inax', 'active'], ['inax-inactive', 'inax', 'inactive']]

const lanes = []
for (const [dir, brand, state] of COHORTS) lanes.push({ id: `A-${dir}`, group: 'prices', mode: 'archived-direct', brand, state, csv: pin(`${OA}/${dir}/archived-direct.csv`), approval: pin(`${OA}/${dir}/archived-direct-approval.json`) })
for (const [dir, brand, state] of COHORTS) lanes.push({ id: `B-${dir}`, group: 'prices', mode: 'candidates', brand, state, csv: pin(`${OA}/${dir}/candidate.csv`), approval: pin(`${OA}/${dir}/owner-approval.json`) })
lanes.push({ id: 'C-inax-active', group: 'prices', mode: 'baseline', brand: 'inax', state: 'active', csv: pin(`${OA}/inax-active/inax-baseline-hold.csv`), approval: pin(`${OA}/inax-active/inax-baseline-owner-decision.json`) })
for (const [dir, brand, state] of COHORTS) lanes.push({ id: `D-${dir}`, group: 'prices', mode: 'status', brand, state, csv: pin(`${IH}/${dir}/status-review.csv`) })
for (const [dir, brand, state] of COHORTS) lanes.push({ id: `E-${dir}`, group: 'voucher', mode: 'voucher', brand, state, csv: pin(`${VL}/voucher-approved.csv`), approval: pin(`${VL}/voucher-approval.json`) })

const step = (id, file, vars = {}) => ({ id, ...pin(file), vars })
const production = { target: 'production', admin_role: 'dpg_admin_api' }
const allowlist = {
  schema: 1,
  target: { project_name: 'dongphugia-runtime', region: 'ap-southeast-1', environment: 'preview', ceiling_bytes: 367001600, project_ref: 'bonxyxluzlxfkdetryoo', effective_role: 'postgres' },
  min_headroom_bytes: 8 * 1024 * 1024,
  backup: { workflow: '.github/workflows/m4-production-backup.yml', max_age_minutes: 120, backup_step: 'Row-count manifest, encrypted dump and checksums', restore_job: 'restore-rehearsal' },
  sql: {
    'apply-004': [step('p470-004', `${P}/004_commerce_direct_access_lock.sql`)],
    'apply-schema': [step('p470-001', `${P}/001_canonical_price_columns.sql`), step('p470-002', `${P}/002_canonical_price_grants.sql`), step('commerce-001', `${C}/001_commerce_schema.sql`, production)],
    'rollback-schema': [step('commerce-001-rollback', `${C}/001_commerce_schema_rollback.sql`, { target: 'production' }), step('p470-002-rollback', `${P}/002_canonical_price_grants_rollback.sql`), step('p470-001-rollback', `${P}/001_canonical_price_columns_rollback.sql`)],
  },
  scope_index: pin(`${OA}/scope-index.csv`),
  planner: pin('scripts/hita-price-audit/prod-import.mts'),
  lanes,
  // Row counts the Owner approved (TL 7140216552 / 7128797116): the plan-set must reproduce them or the lane stops.
  expected: { prices: { rows: 4648, lanes: 9 }, status: { rows: 1284 }, voucher: { rows: 1101 } },
}
const text = JSON.stringify(allowlist, null, 2) + '\n'
if (process.argv.includes('--check')) { if (readFileSync('scripts/m6/allowlist.json', 'utf8') !== text) { console.error('M6_ALLOWLIST_DRIFT'); process.exit(1) } console.log('M6_ALLOWLIST_OK') }
else { writeFileSync('scripts/m6/allowlist.json', text); console.log(`wrote scripts/m6/allowlist.json (${lanes.length} lanes)`) }
