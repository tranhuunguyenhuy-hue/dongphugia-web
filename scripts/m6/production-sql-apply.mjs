#!/usr/bin/env node
// #470 m6 — Production SQL lane orchestrator (runs ONLY from .github/workflows/m6-production-sql-apply.yml; never on merge, never on a schedule).
// It can touch nothing that is not pinned in scripts/m6/allowlist.json (files by sha256, plans by lane). No SQL text, path or identifier comes from an input.
// FAIL CLOSED: every check throws M6_*; psql runs with ON_ERROR_STOP; one advisory lock prevents concurrent runs; secrets are never printed (they travel in env vars).
//   env: DATABASE_URL (operator credential, environment secret) · M6_OPERATION · M6_APPROVED_SHA · GITHUB_SHA · M6_GROUP · M6_PLAN_SET_SHA256 · M6_RESUME
//        M6_BACKUP_EVIDENCE (json from the workflow's GitHub API check) · M6_ROLLBACK_DIR (artifact of the apply run) · M6_OUT (artifact dir) · GITHUB_STEP_SUMMARY
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import pg from 'pg'
import { MUTATING, assertBackupEvidence, assertCapabilities, assertExpectedCounts, assertGo, assertHeadroom, assertPlanSetMatches, assertProductionHost, assertTarget, loadAllowlist, pinsFor, planSetSha, sha256, sha256File, verifyPinned } from './lib.mjs'

const run = promisify(execFile)
const root = process.cwd()
const env = process.env
const say = (line) => { console.log(line); if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`) }
const fail = (code, detail = '') => { throw new Error(detail ? `${code}:${detail}` : code) }
const ident = (name) => { if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) fail('M6_BAD_IDENTIFIER', name); return `"${name}"` }

/** psql reads the credential from the environment (never argv). */
function pgEnv(databaseUrl) {
  const url = new URL(databaseUrl)
  return { PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)) || 'postgres', PGSSLMODE: url.searchParams.get('sslmode') ?? env.PGSSLMODE ?? 'require', PGCONNECT_TIMEOUT: '15' }
}
const psqlFile = (database, effectiveRole, file, vars) => new Promise((resolve, reject) => {
  const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...Object.entries(vars).flatMap(([k, v]) => ['-v', `${k}=${v}`]), ...(effectiveRole ? ['-c', `set role ${ident(effectiveRole)}`] : []), '-f', file]
  const child = spawn('psql', args, { env: { ...env, ...pgEnv(database) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''; child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
  child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`M6_PSQL_FAILED:${path.basename(file)}:${err.split('\n').filter(Boolean).slice(-3).join(' | ').replaceAll(database, '<url>')}`)))
})

async function connect(databaseUrl, effectiveRole) {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'm6-production-sql-apply', statement_timeout: 120000 }); await client.connect()
  if ((await client.query('select session_user as s')).rows[0].s !== effectiveRole) { try { await client.query(`set role ${ident(effectiveRole)}`) } catch { fail('M6_CANNOT_SET_EFFECTIVE_ROLE', effectiveRole) } }
  return client
}
const one = async (client, sql, params = []) => (await client.query(sql, params)).rows[0]

async function capabilities(client) {
  const r = await one(client, "select current_user as effective_role, session_user as login_role, rolsuper, rolcreaterole, rolbypassrls from pg_roles where rolname = current_user")
  return { effective_role: r.effective_role, login_role: r.login_role, superuser: r.rolsuper, createrole: r.rolcreaterole, bypassrls: r.rolbypassrls }
}
async function state(client) {
  const r = await one(client, `select
    (select count(*) from pg_attribute where attrelid='dpg_app.products'::regclass and not attisdropped and attname in ('regular_price_vnd','promotional_price_vnd','online_voucher_amount_vnd','canonical_price_status','canonical_price_checked_at'))::int as canonical_columns,
    exists(select 1 from pg_namespace where nspname='dpg_commerce') as commerce_schema,
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','dpg_app') and (p.proname like 'runtime_order%' or p.proname like 'runtime_quote%') and has_function_privilege('authenticated', p.oid, 'execute'))::int as authenticated_runtime_rpcs,
    (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='dpg_app' and c.relname in ('orders','order_items','quote_requests','quote_items','runtime_idempotency_records') and (has_table_privilege('authenticated',c.oid,'insert') or has_table_privilege('authenticated',c.oid,'update') or has_table_privilege('authenticated',c.oid,'delete')))::int as authenticated_writable_legacy_tables,
    pg_database_size(current_database())::bigint as db_bytes,
    (select count(*) from pg_stat_activity where datname=current_database())::int as connections, current_setting('max_connections')::int as max_connections`)
  const commerceRows = r.commerce_schema ? await one(client, "select (select count(*) from dpg_commerce.orders) + (select count(*) from dpg_commerce.quotes) as n").catch(() => ({ n: -1 })) : { n: 0 }
  return { ...r, db_bytes: Number(r.db_bytes), commerce_rows: Number(commerceRows.n) }
}

async function runSqlSteps(list, operation, database, effectiveRole, approvedSha, client) {
  const steps = list.sql[operation]; verifyPinned(root, steps)
  for (const step of steps) {
    if (step.id === 'commerce-001' && (await state(client)).commerce_schema) fail('M6_ALREADY_APPLIED', 'commerce-001 (run rollback-schema first; it refuses while any order/quote exists)')
    if (step.id === 'commerce-001-rollback') { const s = await state(client); if (s.commerce_rows !== 0) fail('M6_ROLLBACK_REFUSED_ORDERS_EXIST', String(s.commerce_rows)) }
    const started = Date.now()
    await psqlFile(database, effectiveRole, path.join(root, step.file), { approved_sha: approvedSha, ...step.vars })
    say(`- \`${step.id}\` applied (${Date.now() - started} ms) · sha256 \`${step.sha256.slice(0, 16)}…\``)
  }
}

/** Post-conditions read back from the live database (independent of the SQL files' own checks). */
async function verifyAfter(operation, client) {
  const s = await state(client)
  if (operation === 'apply-004' && (s.authenticated_runtime_rpcs !== 4 || s.authenticated_writable_legacy_tables !== 0)) fail('M6_004_POSTCONDITION_FAILED', `rpcs=${s.authenticated_runtime_rpcs} tables=${s.authenticated_writable_legacy_tables}`)
  if (operation === 'apply-schema' && (s.canonical_columns !== 5 || !s.commerce_schema)) fail('M6_SCHEMA_POSTCONDITION_FAILED', `cols=${s.canonical_columns} commerce=${s.commerce_schema}`)
  if (operation === 'rollback-schema' && (s.canonical_columns !== 0 || s.commerce_schema)) fail('M6_ROLLBACK_POSTCONDITION_FAILED')
  return s
}

// ---------------------------------------------------------------------------------------------------- import
const SNAPSHOT = "select json_build_object('db_size_bytes', pg_database_size(current_database()), 'rows', (select coalesce(json_agg(t), '[]'::json) from (select id, sku, category_id, brand_id, is_active, version, canonical_price_status, regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd, canonical_price_checked_at from dpg_app.products where category_id = 1 and brand_id = $1 order by id) t)) as snapshot"
const BRAND_ID = { toto: 1, inax: 2 }
async function snapshotFor(client, brand) {
  await client.query('begin read only'); try { return (await one(client, SNAPSHOT, [BRAND_ID[brand]])).snapshot } finally { await client.query('rollback') }
}
async function buildPlans(list, group, client, approvedSha, outRoot) {
  verifyPinned(root, pinsFor(list, 'plan-import', group))
  mkdirSync(outRoot, { recursive: true })
  const scope = readFileSync(path.join(root, list.scope_index.file), 'utf8').replace(/^﻿/, '').split(/\r?\n/).slice(1).filter(Boolean).map((line) => line.split('","').map((c) => c.replace(/^"|"$/g, '')))
  const inventory = scope.map((c) => ({ id: Number(c[3]), sku: c[4], is_active: c[1] === 'true' }))
  const inventoryFile = path.join(outRoot, 'inventory.json'); writeFileSync(inventoryFile, JSON.stringify(inventory))
  const plans = [], snapshots = {}
  for (const lane of list.lanes.filter((l) => l.group === group)) {
    snapshots[lane.brand] ??= await snapshotFor(client, lane.brand)
    const snapFile = path.join(outRoot, `snapshot-${lane.brand}.json`); writeFileSync(snapFile, JSON.stringify(snapshots[lane.brand]))
    const dir = path.join(outRoot, lane.id), csv = path.join(root, lane.csv.file)
    const args = ['tsx', path.join(root, list.planner.file), csv, '--csv-sha256', lane.csv.sha256, '--candidate-sha', approvedSha, '--db-snapshot', snapFile, '--now', new Date().toISOString(), '--brand', lane.brand, '--state', lane.state, '--out', dir]
    if (lane.mode === 'archived-direct') args.push('--inventory', inventoryFile, '--archived-direct-approval', path.join(root, lane.approval.file))
    else if (lane.mode === 'candidates') args.push('--owner-candidates', path.join(root, lane.approval.file))
    else if (lane.mode === 'baseline') args.push('--inax-baseline-decision', path.join(root, lane.approval.file))
    else if (lane.mode === 'voucher') args.push('--voucher-approval', path.join(root, lane.approval.file))
    else args.push('--inventory', inventoryFile)                                           // status lane (review-format CSV, no price)
    let report; try { report = JSON.parse((await run('npx', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout) } catch (error) { try { report = JSON.parse(error.stdout) } catch { fail('M6_PLANNER_FAILED', lane.id) } }
    const ledger = existsSync(path.join(dir, 'ledger.jsonl')) ? readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean) : []
    const batches = existsSync(dir) ? readdirSync(dir).filter((f) => /^batch-\d{4}-apply\.sql$/.test(f)).sort() : []
    plans.push({ lane: lane.id, mode: lane.mode, brand: lane.brand, state: lane.state, plan_sha: report.plan_sha, rows: ledger.length, ledger_sha256: ledger.length ? sha256File(path.join(dir, 'ledger.jsonl')) : null, batches: batches.length, batch_sha256: batches.map((f) => sha256File(path.join(dir, f))), stop_reasons: report.stop_reasons ?? [], headroom_after_bytes: report.headroom_after_bytes })
  }
  return plans
}
function report(group, plans, approvedSha) {
  const set = planSetSha(plans)
  say(`#### Plan set \`${group}\` · SHA \`${approvedSha.slice(0, 12)}\` · **plan_set_sha256 = \`${set}\`**`)
  say('| lane | mode | brand/state | rows | batches | plan_sha | stop |'); say('|---|---|---|---:|---:|---|---|')
  for (const p of plans) say(`| ${p.lane} | ${p.mode} | ${p.brand}/${p.state} | ${p.rows} | ${p.batches} | \`${p.plan_sha?.slice(0, 16)}…\` | ${p.stop_reasons.join(', ') || '—'} |`)
  return set
}

async function applyImport(list, group, client, database, effectiveRole, approvedSha, outRoot) {
  const plans = await buildPlans(list, group, client, approvedSha, outRoot)
  const resume = env.M6_RESUME === 'true'
  assertExpectedCounts(group, plans, list.expected, { resume })
  const set = report(group, plans, approvedSha)
  assertPlanSetMatches(env.M6_PLAN_SET_SHA256, set)
  writeFileSync(path.join(outRoot, 'plan-set.json'), JSON.stringify({ group, approved_sha: approvedSha, plan_set_sha256: set, lanes: plans }, null, 2))
  const ledger = path.join(outRoot, 'apply-ledger.jsonl')
  for (const plan of plans.filter((p) => p.rows > 0)) {
    for (let i = 1; i <= plan.batches; i++) {
      const n = String(i).padStart(4, '0'), file = path.join(outRoot, plan.lane, `batch-${n}-apply.sql`)
      if (sha256File(file) !== plan.batch_sha256[i - 1]) fail('M6_BATCH_CHANGED_AFTER_PLAN', `${plan.lane}/${n}`)
      assertHeadroom((await state(client)).db_bytes, list.target.ceiling_bytes, list.min_headroom_bytes)
      await psqlFile(database, effectiveRole, file, { approved_sha: plan.plan_sha })       // the batch's own guard requires its plan sha (GO token)
      appendFileSync(ledger, JSON.stringify({ lane: plan.lane, batch: i, of: plan.batches, plan_sha: plan.plan_sha, batch_sha256: plan.batch_sha256[i - 1], at: new Date().toISOString() }) + '\n')
    }
    say(`- lane \`${plan.lane}\`: ${plan.rows} rows in ${plan.batches} batches applied`)
  }
  return set
}
/** Classify one applied batch against the live rows: every row at its AFTER state (rollback it), every row at its BEFORE state (already rolled back: skip, so a retry resumes), anything else (a newer edit) = stop. */
async function classifyBatch(client, ledgerRows) {
  const ids = ledgerRows.map((r) => r.id)
  const live = new Map((await client.query('select id, canonical_price_status as s, regular_price_vnd as r, promotional_price_vnd as p, online_voucher_amount_vnd as v, canonical_price_checked_at as c from dpg_app.products where id = any($1)', [ids])).rows.map((r) => [Number(r.id), r]))
  const num = (x) => (x === null || x === undefined ? null : Number(x)), time = (x) => (x === null || x === undefined ? null : new Date(x).getTime())
  const at = (row, canon, checked) => row && row.s === canon.status && num(row.r) === num(canon.regular) && num(row.p) === num(canon.promo) && num(row.v) === num(canon.voucher) && time(row.c) === time(checked)
  let after = 0, before = 0
  for (const entry of ledgerRows) { const row = live.get(Number(entry.id)); if (at(row, entry.after, entry.checked_at)) after++; else if (at(row, entry.before, entry.before_checked_at)) before++; else return 'unexpected' }
  return after === ledgerRows.length ? 'applied' : before === ledgerRows.length ? 'rolled-back' : 'unexpected'
}
/** Roll one applied batch back from the LEDGER against the LIVE rows: every row must still hold exactly the value the apply wrote (so a later Admin edit or a later lane that is still applied stops the rollback); the version moves forward, never back. One transaction per batch. */
async function rollbackBatchFromLedger(client, rows, brandId, active) {
  const col = (f) => rows.map(f), n = (x) => (x === null || x === undefined ? null : Number(x))
  await client.query('begin'); await client.query("set local lock_timeout = '5s'"); await client.query("set local statement_timeout = '60s'")
  try {
    const result = await client.query(`update dpg_app.products p set canonical_price_status = v.ts, regular_price_vnd = v.tr, promotional_price_vnd = v.tp, online_voucher_amount_vnd = v.tv, canonical_price_checked_at = v.tc, version = p.version + 1
      from unnest($1::int[], $2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::bigint[], $7::timestamptz[], $8::text[], $9::bigint[], $10::bigint[], $11::bigint[], $12::timestamptz[]) as v(id, sku, fs, fr, fp, fv, fc, ts, tr, tp, tv, tc)
      where p.id = v.id and p.sku = v.sku and p.category_id = 1 and p.brand_id = $13 and p.is_active = $14
        and p.canonical_price_status is not distinct from v.fs and p.regular_price_vnd is not distinct from v.fr and p.promotional_price_vnd is not distinct from v.fp
        and p.online_voucher_amount_vnd is not distinct from v.fv and p.canonical_price_checked_at is not distinct from v.fc`,
    [col((r) => r.id), col((r) => r.sku), col((r) => r.after.status), col((r) => n(r.after.regular)), col((r) => n(r.after.promo)), col((r) => n(r.after.voucher)), col((r) => r.checked_at),
      col((r) => r.before.status), col((r) => n(r.before.regular)), col((r) => n(r.before.promo)), col((r) => n(r.before.voucher)), col((r) => r.before_checked_at), brandId, active])
    if (result.rowCount !== rows.length) fail('M6_ROLLBACK_ROWCOUNT_MISMATCH', `expected=${rows.length} got=${result.rowCount}`)
    await client.query('commit')
  } catch (error) { await client.query('rollback').catch(() => undefined); throw error }
}
async function rollbackImport(list, client, database, effectiveRole, dir) {
  if (!dir || !existsSync(path.join(dir, 'plan-set.json'))) fail('M6_ROLLBACK_ARTIFACT_MISSING')
  const planSet = JSON.parse(readFileSync(path.join(dir, 'plan-set.json'), 'utf8')), laneInfo = new Map(planSet.lanes.map((l) => [l.lane, l]))
  const ledger = existsSync(path.join(dir, 'apply-ledger.jsonl')) ? readFileSync(path.join(dir, 'apply-ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
  if (!ledger.length) fail('M6_NOTHING_TO_ROLL_BACK')
  const known = new Set(list.lanes.map((l) => l.id)); for (const entry of ledger) if (!known.has(entry.lane)) fail('M6_UNKNOWN_LANE_IN_LEDGER', entry.lane)
  for (const entry of ledger.slice().reverse()) {                                            // newest batch first: the batch rollback refuses if a newer version exists
    const n = String(entry.batch).padStart(4, '0'), apply = path.join(dir, entry.lane, `batch-${n}-apply.sql`)
    if (sha256File(apply) !== entry.batch_sha256) fail('M6_ROLLBACK_ARTIFACT_TAMPERED', `${entry.lane}/${n}`)
    if (sha256File(path.join(dir, entry.lane, 'ledger.jsonl')) !== laneInfo.get(entry.lane)?.ledger_sha256) fail('M6_ROLLBACK_LEDGER_TAMPERED', entry.lane)
    const rows = readFileSync(path.join(dir, entry.lane, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.batch === entry.batch)
    const status = await classifyBatch(client, rows)
    if (status === 'rolled-back') { say(`- \`${entry.lane}\` batch ${entry.batch}/${entry.of}: already rolled back (skipped)`); continue }
    if (status !== 'applied') fail('M6_ROLLBACK_STATE_UNEXPECTED', `${entry.lane}/${n}: rows were edited after the apply — stop and review`)
    const lane = list.lanes.find((l) => l.id === entry.lane)
    await rollbackBatchFromLedger(client, rows, BRAND_ID[lane.brand], lane.state === 'active')
    say(`- rolled back \`${entry.lane}\` batch ${entry.batch}/${entry.of}`)
  }
}

// ---------------------------------------------------------------------------------------------------- provision (role + Hyperdrive; only after backup + GO)
async function provisionIntake(client, list) {
  const role = 'dpg_order_intake_login'
  const password = (await import('node:crypto')).randomBytes(24).toString('base64url'); console.log(`::add-mask::${password}`)
  await client.query("select set_config('m6.pw', $1, false)", [password])
  await client.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = '${role}') then execute format('create role ${role} login noinherit connection limit 5 password %L', current_setting('m6.pw'));
    else execute format('alter role ${role} login noinherit connection limit 5 password %L', current_setting('m6.pw')); end if;
    execute 'alter role ${role} set statement_timeout = ''5s''';
    execute 'alter role ${role} set idle_in_transaction_session_timeout = ''10s''';
    if not exists (select 1 from pg_roles where rolname = 'dpg_commerce_intake') then raise exception 'M6_COMMERCE_SCHEMA_NOT_APPLIED'; end if;
    execute 'grant dpg_commerce_intake to ${role}';
  end $$`)
  await client.query("select set_config('m6.pw', '', false)")
  const caps = await one(client, `select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolconnlimit,
    (select coalesce(jsonb_agg(r.rolname order by r.rolname),'[]') from pg_auth_members am join pg_roles r on r.oid=am.roleid join pg_roles m on m.oid=am.member where m.rolname='${role}') as member_of from pg_roles where rolname='${role}'`)
  if (caps.rolsuper || caps.rolbypassrls || caps.rolcreaterole || JSON.stringify(caps.member_of) !== '["dpg_commerce_intake"]') fail('M6_INTAKE_ROLE_NOT_LEAST_PRIVILEGE', JSON.stringify(caps))
  say(`- role \`${role}\`: login, NOINHERIT, connection limit ${caps.rolconnlimit}, member of ${JSON.stringify(caps.member_of)} only`)
  // Hyperdrive: same origin host/port/db as the read-only Production config, a different user, caching DISABLED, small origin cap.
  const account = env.CLOUDFLARE_ACCOUNT_ID, token = env.CLOUDFLARE_API_TOKEN, readonlyId = env.V1_PUBLIC_HYPERDRIVE_ID
  if (!account || !token || !readonlyId) fail('M6_CLOUDFLARE_INPUTS_MISSING')
  const api = async (method, p, body) => { const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!j.success) fail('M6_CLOUDFLARE_API_FAILED', `${method} ${p} ${r.status} ${(j.errors ?? []).map((e) => e.code).join(',')}`); return j.result }
  const origin = (await api('GET', `/hyperdrive/configs/${readonlyId}`)).origin
  const name = 'dpg-v1-production-order-intake', existing = (await api('GET', '/hyperdrive/configs')).find((c) => c.name === name)
  const body = { name, origin: { scheme: origin.scheme, host: origin.host, port: origin.port, database: origin.database, user: role, password }, caching: { disabled: true }, origin_connection_limit: 5 }
  const config = existing ? await api('PUT', `/hyperdrive/configs/${existing.id}`, body) : await api('POST', '/hyperdrive/configs', body)
  if (config.caching?.disabled !== true) fail('M6_HYPERDRIVE_CACHING_NOT_DISABLED')
  say(`- Hyperdrive \`${name}\` id **\`${config.id}\`** (caching disabled, origin cap 5). Owner: set repository variable V1_PUBLIC_COMMERCE_HYPERDRIVE_ID to this id.`)
}

// ---------------------------------------------------------------------------------------------------- main
async function main() {
  const operation = env.M6_OPERATION, approvedSha = env.M6_APPROVED_SHA, group = env.M6_GROUP || undefined
  assertGo({ operation, approvedSha, githubSha: env.GITHUB_SHA, group, planSetSha256: env.M6_PLAN_SET_SHA256 })
  if (!env.DATABASE_URL) fail('M6_DATABASE_URL_MISSING')
  const testAllowlist = env.M6_TEST_ALLOWLIST    // honoured ONLY against a non-production contract (checked below); the workflow never sets it
  const list = loadAllowlist(testAllowlist ? path.resolve(testAllowlist) : path.join(root, 'scripts/m6/allowlist.json'))
  // Test-only overrides (allowlist, effective role) are honoured ONLY when the database is on loopback: a hosted Production URL can never use them.
  if (testAllowlist) { const host = new URL(env.DATABASE_URL).hostname; if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) fail('M6_TEST_OVERRIDE_REFUSED_OFF_LOOPBACK') }
  const effectiveRole = testAllowlist ? (env.M6_EFFECTIVE_ROLE || list.target.effective_role) : list.target.effective_role
  say(`### m6 Production SQL lane · \`${operation}\`${group ? ` · group \`${group}\`` : ''} · approved SHA \`${approvedSha.slice(0, 12)}\``)
  verifyPinned(root, pinsFor(list, operation, group))
  if (!testAllowlist) assertProductionHost(env.DATABASE_URL, list.target.project_ref)
  const client = await connect(env.DATABASE_URL, effectiveRole)
  try {
    const lock = await one(client, "select pg_try_advisory_lock(hashtext('m6-production-sql-apply')) as ok"); if (!lock.ok) fail('M6_ANOTHER_RUN_IN_PROGRESS')
    const contract = await one(client, 'select project_name, region, environment, hard_database_ceiling_bytes, production_data_allowed, production_writes_allowed from dpg_control.target_contract limit 1')
    assertTarget(contract, list.target)
    const caps = await capabilities(client)
    assertCapabilities(caps, effectiveRole, operation)
    const before = await state(client)
    assertHeadroom(before.db_bytes, list.target.ceiling_bytes, list.min_headroom_bytes)
    say(`- target OK (project \`${contract.project_name}\`, ${contract.environment}) · operator \`${caps.login_role}\`→\`${caps.effective_role}\` · DB ${(before.db_bytes / 1048576).toFixed(1)} MiB / ${(list.target.ceiling_bytes / 1048576).toFixed(0)} MiB · connections ${before.connections}/${before.max_connections}`)
    say(`- state: canonical columns ${before.canonical_columns}/5 · commerce schema ${before.commerce_schema} · authenticated runtime RPCs ${before.authenticated_runtime_rpcs} · authenticated-writable legacy tables ${before.authenticated_writable_legacy_tables}`)
    const outRoot = env.M6_OUT || path.join(root, '.m6-out'); mkdirSync(outRoot, { recursive: true })
    if (MUTATING.has(operation)) { const age = assertBackupEvidence(env.M6_BACKUP_EVIDENCE ? JSON.parse(env.M6_BACKUP_EVIDENCE) : null, list.backup); say(`- backup proof OK (run ${JSON.parse(env.M6_BACKUP_EVIDENCE).run_id}, ${age} min old, dump + restore rehearsal passed)`) }
    if (operation === 'preflight') return
    if (operation === 'apply-004' || operation === 'apply-schema' || operation === 'rollback-schema') { await runSqlSteps(list, operation, env.DATABASE_URL, effectiveRole === caps.login_role ? '' : effectiveRole, approvedSha, client); const after = await verifyAfter(operation, client); say(`- after: canonical columns ${after.canonical_columns}/5 · commerce schema ${after.commerce_schema} · authenticated runtime RPCs ${after.authenticated_runtime_rpcs} · writable legacy tables ${after.authenticated_writable_legacy_tables}`) }
    else if (operation === 'plan-import') { const plans = await buildPlans(list, group, client, approvedSha, outRoot); assertExpectedCounts(group, plans, list.expected, { resume: env.M6_RESUME === 'true' }); writeFileSync(path.join(outRoot, 'plan-set.json'), JSON.stringify({ group, approved_sha: approvedSha, plan_set_sha256: report(group, plans, approvedSha), lanes: plans }, null, 2)) }
    else if (operation === 'apply-import') { await applyImport(list, group, client, env.DATABASE_URL, effectiveRole === caps.login_role ? '' : effectiveRole, approvedSha, outRoot); const after = await state(client); say(`- after: DB ${(after.db_bytes / 1048576).toFixed(1)} MiB`) }
    else if (operation === 'rollback-import') await rollbackImport(list, client, env.DATABASE_URL, effectiveRole === caps.login_role ? '' : effectiveRole, env.M6_ROLLBACK_DIR)
    else if (operation === 'provision-intake') await provisionIntake(client, list)
    say('**RESULT: PASS**')
  } finally { await client.query("select pg_advisory_unlock(hashtext('m6-production-sql-apply'))").catch(() => undefined); await client.end().catch(() => undefined) }
}
main().then(() => process.exit(0), (error) => { const message = String(error.message ?? error).replaceAll(env.DATABASE_URL ?? '\u0000', '<url>'); say(`**RESULT: FAIL** \`${message.split('\n')[0].slice(0, 400)}\``); process.exit(1) })
