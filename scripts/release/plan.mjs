// #511 Full Release Pipeline: the versioned release PLAN. A plan is reviewed in a PR like code and executed only by the existing
// protected lanes; dispatch inputs carry ids and the expected digest only (never SQL text, a path, a command or a URL).
//
// release/plans/<plan-id>/plan.json + the SQL files it names (nothing else in that folder except README.md).
// Steps form a DAG per environment (test, then production). Types and what executes them:
//   sql       forward SQL in one transaction, precheck before / postcheck inside the same transaction   → plan-sql.mjs via M6 / TEST lane
//   backfill  one idempotent single-statement batch repeated until it changes 0 rows, then postcheck    → plan-sql.mjs (resumable)
//   function  deploy of an allowlisted Supabase function                                                → m3 (TEST) / m4 (Production) function lanes
//   worker    combined Worker: fixed Staging publish-m3 (TEST) / M4 publish (Production); `bindings` = wrangler change rides here
// Expand → migrate → contract: a step that drops or rewrites data must be `destructive`, a grant/role/policy change `privileged`;
// both need a separate Owner approval line per step. If the Worker depends on SQL steps, the OLD Worker must work with the NEW
// schema (`compatibility.old_worker_with_new_schema`); otherwise the plan is refused and needs a separate maintenance/cutover plan.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { appendSummary, isMain, writeOutputs } from './lib.mjs'

export const PLANS_DIR = 'release/plans'
export const STEP_TYPES = Object.freeze(['sql', 'backfill', 'function', 'worker'])
export const FUNCTIONS = Object.freeze(['admin-api'])
const ID = /^[a-z0-9][a-z0-9-]{2,60}$/
const STEP_ID = /^[a-z][a-z0-9-]{1,40}$/
const FILE = /^[a-z0-9][a-z0-9._-]{0,80}\.sql$/
const ROLLBACK = { sql: ['sql', 'forward-fix'], backfill: ['sql', 'forward-fix'], function: ['function-redeploy-previous', 'forward-fix'], worker: ['worker-rollback'] }
const KEYS = {
  sql: { required: ['id', 'type', 'depends_on', 'sql', 'precheck', 'postcheck', 'rollback'], optional: ['destructive', 'privileged', 'statement_timeout_s', 'note'] },
  backfill: { required: ['id', 'type', 'depends_on', 'batch', 'precheck', 'postcheck', 'rollback', 'max_batches'], optional: ['statement_timeout_s', 'note'] },
  function: { required: ['id', 'type', 'depends_on', 'function', 'rollback'], optional: ['note'] },
  worker: { required: ['id', 'type', 'depends_on', 'rollback'], optional: ['bindings', 'note'] },
}
// Coverable outside the plan folder: function and binding sources, and SQL-lane tooling. Schema/migration sources elsewhere are not.
const COVERABLE = [/^supabase\/functions\//, /(^|\/)wrangler[^/]*\.jsonc?$/, /^scripts\/(m6|db|migration)\//]

const fail = (code, detail = '') => { throw new Error(detail ? `${code}:${detail}` : code) }
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}` : JSON.stringify(value)
const exactKeys = (obj, { required, optional = [] }, where) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail('PLAN_NOT_OBJECT', where)
  for (const k of required) if (!(k in obj)) fail('PLAN_KEY_MISSING', `${where}.${k}`)
  for (const k of Object.keys(obj)) if (![...required, ...optional].includes(k)) fail('PLAN_KEY_UNKNOWN', `${where}.${k}`)
}

// SQL lint (comments and string literals stripped first). Prechecks/postchecks must be read-only queries returning `ok`.
const stripSql = (sql) => sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''")
const TXN_CONTROL = /\b(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|SAVEPOINT|END)\s*;|\bCONCURRENTLY\b|\bVACUUM\b/i
const DESTRUCTIVE = /\b(DROP\s+(TABLE|COLUMN|SCHEMA|VIEW|MATERIALIZED|FUNCTION|TYPE|SEQUENCE|INDEX|TRIGGER|CONSTRAINT)|TRUNCATE|DELETE\s+FROM|ALTER\s+TABLE[^;]*\b(DROP|RENAME|ALTER\s+COLUMN[^;]*\bTYPE)\b|ALTER\s+TYPE|RENAME\s+TO)\b/i
const PRIVILEGED = /\b(GRANT|REVOKE|CREATE\s+ROLE|ALTER\s+ROLE|DROP\s+ROLE|CREATE\s+USER|ALTER\s+USER|ALTER\s+DEFAULT\s+PRIVILEGES|SECURITY\s+DEFINER|CREATE\s+POLICY|ALTER\s+POLICY|DROP\s+POLICY|(EN|DIS)ABLE\s+ROW\s+LEVEL|NO\s+FORCE\s+ROW\s+LEVEL|OWNER\s+TO|SET\s+ROLE|SET\s+SESSION)\b/i
const WRITES = /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|GRANT|REVOKE|TRUNCATE|COPY|CALL|DO|SET|LOCK|NOTIFY|REFRESH|SECURITY)\b/i

export function lintSql(text, kind, step) {
  const sql = stripSql(text)
  if (!sql.trim()) fail('PLAN_SQL_EMPTY', step.id)
  if (TXN_CONTROL.test(sql)) fail('PLAN_SQL_TRANSACTION_CONTROL_OR_CONCURRENTLY', step.id)
  if (kind === 'check') {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql) || WRITES.test(sql) || sql.replace(/;\s*$/, '').includes(';')) fail('PLAN_CHECK_NOT_READ_ONLY_SINGLE_QUERY', step.id)
    return
  }
  if (kind === 'batch' && sql.trim().replace(/;\s*$/, '').includes(';')) fail('PLAN_BATCH_NOT_SINGLE_STATEMENT', step.id)
  if (kind === 'rollback') return // a rollback reverses the forward change by nature; executing it needs its own approval line
  if (DESTRUCTIVE.test(sql) && step.destructive !== true) fail('PLAN_DESTRUCTIVE_NOT_DECLARED', step.id)
  if (PRIVILEGED.test(sql) && step.privileged !== true) fail('PLAN_PRIVILEGED_NOT_DECLARED', step.id)
}

export function stepFiles(step) {
  return [step.sql, step.batch, step.precheck, step.postcheck, step.rollback?.kind === 'sql' ? step.rollback.sql : undefined].filter(Boolean)
}

/** Transitive dependencies of a step (ids), in a deterministic order. */
export function ancestors(plan, stepId) {
  const byId = new Map(plan.steps.map((s) => [s.id, s]))
  const seen = new Set()
  const walk = (id) => { for (const dep of byId.get(id)?.depends_on ?? []) if (!seen.has(dep)) { seen.add(dep); walk(dep) } }
  walk(stepId)
  return plan.steps.map((s) => s.id).filter((id) => seen.has(id))
}

/** Strict structural validation of a parsed plan (no file access). */
export function validatePlanShape(plan) {
  exactKeys(plan, { required: ['schema', 'id', 'issue', 'title', 'compatibility', 'steps'], optional: ['covers', 'note', 'test_only'] }, 'plan')
  if (plan.schema !== 1) fail('PLAN_SCHEMA_UNSUPPORTED')
  if (!ID.test(plan.id)) fail('PLAN_ID_INVALID')
  // `test-` plans exist to exercise the lanes on the TEST project: marked, never runnable on Production, never Production release scope.
  if (plan.id.startsWith('test-') !== (plan.test_only === true) || ('test_only' in plan && plan.test_only !== true)) fail('PLAN_TEST_ONLY_MARK_MISMATCH')
  if (!Number.isInteger(plan.issue) || plan.issue < 1) fail('PLAN_ISSUE_INVALID')
  if (typeof plan.title !== 'string' || !plan.title.trim()) fail('PLAN_TITLE_INVALID')
  exactKeys(plan.compatibility, { required: ['old_worker_with_new_schema', 'new_worker_with_old_schema'] }, 'compatibility')
  for (const v of Object.values(plan.compatibility)) if (typeof v !== 'boolean') fail('PLAN_COMPATIBILITY_NOT_BOOLEAN')
  const covers = plan.covers ?? []
  if (!Array.isArray(covers) || covers.some((p) => typeof p !== 'string' || !COVERABLE.some((re) => re.test(p)) || p.includes('..'))) fail('PLAN_COVERS_NOT_ALLOWED')
  if (!Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 30) fail('PLAN_STEPS_INVALID')
  const ids = new Set()
  for (const step of plan.steps) {
    if (!STEP_TYPES.includes(step?.type)) fail('PLAN_STEP_TYPE_INVALID', step?.id)
    exactKeys(step, KEYS[step.type], `step.${step.id}`)
    if (!STEP_ID.test(step.id) || ids.has(step.id)) fail('PLAN_STEP_ID_INVALID_OR_DUPLICATE', step.id)
    ids.add(step.id)
    if (!Array.isArray(step.depends_on) || new Set(step.depends_on).size !== step.depends_on.length) fail('PLAN_DEPENDS_ON_INVALID', step.id)
    for (const f of stepFiles(step)) if (!FILE.test(f)) fail('PLAN_FILE_NAME_INVALID', `${step.id}:${f}`)
    exactKeys(step.rollback, step.rollback?.kind === 'sql' ? { required: ['kind', 'sql'] } : { required: ['kind'], optional: ['note'] }, `step.${step.id}.rollback`)
    if (!ROLLBACK[step.type].includes(step.rollback.kind)) fail('PLAN_ROLLBACK_KIND_INVALID', step.id)
    for (const flag of ['destructive', 'privileged', 'bindings']) if (flag in step && typeof step[flag] !== 'boolean') fail('PLAN_FLAG_NOT_BOOLEAN', `${step.id}.${flag}`)
    if ('statement_timeout_s' in step && !(Number.isInteger(step.statement_timeout_s) && step.statement_timeout_s >= 1 && step.statement_timeout_s <= 900)) fail('PLAN_TIMEOUT_INVALID', step.id)
    if (step.type === 'backfill' && !(Number.isInteger(step.max_batches) && step.max_batches >= 1 && step.max_batches <= 10000)) fail('PLAN_MAX_BATCHES_INVALID', step.id)
    if (step.type === 'function' && !FUNCTIONS.includes(step.function)) fail('PLAN_FUNCTION_NOT_ALLOWED', step.id)
  }
  for (const step of plan.steps) for (const dep of step.depends_on) if (!ids.has(dep) || dep === step.id) fail('PLAN_DEPENDENCY_UNKNOWN', `${step.id}->${dep}`)
  // Acyclic (Kahn).
  const indegree = new Map(plan.steps.map((s) => [s.id, s.depends_on.length]))
  const queue = [...indegree].filter(([, n]) => n === 0).map(([id]) => id)
  let visited = 0
  while (queue.length) { const id = queue.shift(); visited += 1; for (const s of plan.steps) if (s.depends_on.includes(id)) { indegree.set(s.id, indegree.get(s.id) - 1); if (!indegree.get(s.id)) queue.push(s.id) } }
  if (visited !== plan.steps.length) fail('PLAN_DEPENDENCY_CYCLE')
  const workers = plan.steps.filter((s) => s.type === 'worker')
  if (workers.length > 1) fail('PLAN_MORE_THAN_ONE_WORKER_STEP')
  if (workers[0]) {
    const before = ancestors(plan, workers[0].id).map((id) => plan.steps.find((s) => s.id === id))
    if (before.some((s) => ['sql', 'backfill'].includes(s.type)) && !plan.compatibility.old_worker_with_new_schema) fail('PLAN_INCOMPATIBLE_REQUIRES_MAINTENANCE_PLAN')
    if (before.some((s) => s.destructive)) fail('PLAN_CONTRACT_BEFORE_WORKER') // contract only after the new Worker serves traffic
  }
  return plan
}

/** Load, validate files and lint SQL; return the plan with its deterministic digest. */
export function loadPlan(root, planId) {
  if (!ID.test(planId ?? '')) fail('PLAN_ID_INVALID')
  const dir = path.join(root, PLANS_DIR, planId)
  if (!existsSync(path.join(dir, 'plan.json'))) fail('PLAN_NOT_FOUND', planId)
  const text = readFileSync(path.join(dir, 'plan.json'), 'utf8')
  let plan; try { plan = JSON.parse(text) } catch { fail('PLAN_JSON_INVALID') }
  validatePlanShape(plan)
  if (plan.id !== planId) fail('PLAN_ID_MISMATCH')
  const referenced = new Set(plan.steps.flatMap(stepFiles))
  const present = readdirSync(dir).filter((f) => f !== 'plan.json' && f !== 'README.md')
  for (const f of present) if (!referenced.has(f)) fail('PLAN_FOLDER_HAS_UNREFERENCED_FILE', f)
  const files = {}
  for (const step of plan.steps) {
    const kinds = [[step.sql, 'apply'], [step.batch, 'batch'], [step.precheck, 'check'], [step.postcheck, 'check'], [step.rollback?.sql, 'rollback']]
    for (const [f, kind] of kinds.filter(([f]) => f)) {
      const abs = path.join(dir, f)
      if (!existsSync(abs)) fail('PLAN_FILE_MISSING', f)
      const bytes = readFileSync(abs)
      lintSql(bytes.toString('utf8'), kind, step)
      files[f] = sha256(bytes)
    }
  }
  return withDigest(plan, files)
}

export function withDigest(plan, files) {
  const lines = Object.keys(files).sort().map((f) => `${f}:${files[f]}`)
  const digest = sha256(`${canonical(plan)}\n${lines.join('\n')}`)
  const stepDigest = (id) => {
    const step = plan.steps.find((s) => s.id === id)
    return sha256(`${plan.id}\n${canonical(step)}\n${stepFiles(step).map((f) => `${f}:${files[f]}`).join('\n')}`)
  }
  return { plan, files, digest, short: digest.slice(0, 12), stepDigest }
}

/** Every full-scope file of a release must be released by this plan: inside its folder or listed in `covers` (allowlisted). */
export function coverageGaps(loaded, categories) {
  const gaps = []
  const inPlan = (p) => p.startsWith(`${PLANS_DIR}/${loaded.plan.id}/`)
  const covers = new Set(loaded.plan.covers ?? [])
  for (const [category, files] of Object.entries(categories ?? {})) {
    for (const file of files) {
      if (inPlan(file) || covers.has(file)) continue
      gaps.push(`${category}:${file}`)
    }
  }
  const hasType = (t) => loaded.plan.steps.some((s) => s.type === t)
  if (categories?.function?.length && !hasType('function')) gaps.push('function:no-function-step')
  if (categories?.bindings?.length && !loaded.plan.steps.some((s) => s.type === 'worker' && s.bindings === true)) gaps.push('bindings:no-worker-step-with-bindings')
  return gaps
}

function main() {
  const [command, planId, expected] = process.argv.slice(2)
  const loaded = loadPlan(process.cwd(), planId)
  if (command === 'verify') {
    if (loaded.digest !== expected) fail('PLAN_DIGEST_MISMATCH', `expected ${String(expected).slice(0, 12)} got ${loaded.short}`)
    console.error(`RELEASE_PLAN status=PASS id=${loaded.plan.id} digest=${loaded.digest}`)
    return
  }
  if (command === 'validate' || command === 'digest') {
    writeOutputs({ plan_id: loaded.plan.id, plan_digest: loaded.digest })
    appendSummary(`- Release plan \`${loaded.plan.id}\` digest \`${loaded.digest}\`: ${loaded.plan.steps.map((s) => `${s.id}(${s.type}${s.destructive ? ',destructive' : ''}${s.privileged ? ',privileged' : ''})`).join(' → ')}`)
    console.error(`RELEASE_PLAN status=PASS id=${loaded.plan.id} digest=${loaded.digest}`)
    return
  }
  throw new Error('USAGE: plan.mjs validate|digest <plan-id> | verify <plan-id> <digest>')
}

if (isMain(import.meta.url)) try { main() } catch (error) { console.error(`RELEASE_PLAN status=FAIL reason=${error.message}`); process.exit(1) }
