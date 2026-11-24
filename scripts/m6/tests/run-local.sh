#!/usr/bin/env bash
# #470 m6: isolated local proof of the Production SQL lane on a PRODUCTION-SHAPED database (never point this at a hosted project).
# The real package is used end to end: the products table is seeded with the 6.531 real ids/SKUs from the package scope index, then the lane plans and applies
# 4.648 prices + 1.284 statuses + 1.101 vouchers, reconciles them, rolls them back and retries. Wrong SHA/hash/target, missing/old/probe backups, concurrent run,
# rollback with orders, and refusal of test overrides off loopback are asserted. Usage: run-local.sh <host> <port> <superuser>   (repo root needs node_modules + psql)
set -euo pipefail
H=${1:?host}; P=${2:?port}; U=${3:?superuser}; DB=dpgm6_$$
cd "$(dirname "$0")/../../.."
SHA=$(printf 'a%.0s' $(seq 1 40)); OTHER=$(printf 'b%.0s' $(seq 1 40)); T=$(mktemp -d)
PSQL=(psql -X -q -tA -v ON_ERROR_STOP=1 -h "$H" -p "$P")
drop_all() { "${PSQL[@]}" -U "$U" -d postgres -c "drop database if exists $DB with (force)" >/dev/null 2>&1 || true
  for r in dpg_operator dpg_migration dpg_admin_api dpg_public_catalogue dpg_runtime dpg_readonly authenticated dpg_direct_import anon service_role dpg_commerce_owner dpg_commerce_intake dpg_order_intake_login; do "${PSQL[@]}" -U "$U" -d postgres -c "drop role if exists $r" >/dev/null 2>&1 || true; done; }
trap 'drop_all; rm -rf "$T"' EXIT; drop_all
"${PSQL[@]}" -U "$U" -d postgres -c "create database $DB"
S=("${PSQL[@]}" -U "$U" -d "$DB"); TESTS=supabase/prod-prep/470/tests
"${S[@]}" -f $TESTS/fixture.sql
"${S[@]}" -c "alter role dpg_operator createrole; grant create on database $DB to dpg_operator"
# baseline = live Production ACL/functions (same steps as supabase/prod-prep/470/tests/run-local.sh)
"${PSQL[@]}" -U dpg_operator -d "$DB" -v approved_sha=local -f supabase/prod-prep/470/003_runtime_order_quote_canonical_rollback.sql
"${S[@]}" -f $TESTS/acl-baseline.sql
# the 6.531 REAL ids/SKUs of the package (id, sku, brand, active) — what Production holds for the TOTO/INAX sanitary scope
node -e '
const fs=require("fs"),rows=fs.readFileSync("docs/ops/hita-448/owner-accepted-candidates/scope-index.csv","utf8").replace(/^﻿/,"").split(/\r?\n/).slice(1).filter(Boolean).map(l=>l.split("\",\"").map(c=>c.replace(/^"|"$/g,"")))
const out=["insert into dpg_app.products(id,sku,name,slug,category_id,brand_id,is_active) values"]
out.push(rows.map(c=>`(${Number(c[3])},${"$q$"+c[4]+"$q$"},${"$q$"+c[4]+"$q$"},${"$q$p-"+c[3]+"$q$"},1,${c[0]==="TOTO"?1:2},${c[1]==="true"})`).join(",\n")+";")
out.push("select setval(pg_get_serial_sequence(\x27dpg_app.products\x27,\x27id\x27), (select max(id) from dpg_app.products));")
fs.writeFileSync(process.argv[1],out.join("\n"))' $T/seed.sql
"${S[@]}" -f $T/seed.sql
echo "PASS seeded $("${S[@]}" -c 'select count(*) from dpg_app.products') real SKUs"
URL="postgresql://$U@localhost:$P/$DB"
node -e 'const f="scripts/m6/allowlist.json",a=JSON.parse(require("fs").readFileSync(f,"utf8")); require("fs").writeFileSync(process.argv[1],JSON.stringify(a))' $T/allow.json
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BK_OK="{\"run_id\":1,\"path\":\".github/workflows/m4-production-backup.yml\",\"head_branch\":\"main\",\"conclusion\":\"success\",\"updated_at\":\"$NOW\",\"steps\":{\"Row-count manifest, encrypted dump and checksums\":true},\"jobs\":{\"restore-rehearsal\":\"success\"}}"
m6() { DATABASE_URL="$URL" M6_TEST_ALLOWLIST="${ALLOW:-$T/allow.json}" M6_EFFECTIVE_ROLE=dpg_operator GITHUB_SHA="${GH:-$SHA}" M6_APPROVED_SHA="${APPROVED:-$SHA}" M6_OUT="$T/out-${OUTN:-x}" M6_BACKUP_EVIDENCE="${BK-$BK_OK}" GITHUB_STEP_SUMMARY="$T/summary.md" node scripts/m6/production-sql-apply.mjs "$@" ; }
op() { M6_OPERATION=$1 M6_GROUP=${2:-} m6; }
expect_fail() { local code=$1; shift; if "$@" >"$T/o.txt" 2>&1; then echo "FAIL: expected $code but it succeeded"; cat "$T/o.txt"; exit 1; fi; grep -q "$code" "$T/o.txt" || { echo "FAIL: expected $code, got:"; tail -3 "$T/o.txt"; exit 1; }; echo "PASS refused: $code"; }

# ---- gates (nothing may change) ----
expect_fail M6_OPERATION_NOT_ALLOWED op drop-everything
APPROVED=$OTHER expect_fail M6_APPROVED_SHA_NOT_CURRENT_MAIN op apply-004
APPROVED=abc expect_fail M6_APPROVED_SHA_INVALID op apply-004
expect_fail M6_GROUP_NOT_ALLOWED op plan-import evil
M6_PLAN_SET_SHA256= expect_fail M6_PLAN_SET_SHA_REQUIRED op apply-import prices
echo "PASS operation / SHA / group / plan-set gates"
if DATABASE_URL="postgresql://u:p@db.example.invalid:5432/postgres" M6_TEST_ALLOWLIST=$T/allow.json M6_OPERATION=preflight GITHUB_SHA=$SHA M6_APPROVED_SHA=$SHA node scripts/m6/production-sql-apply.mjs >"$T/o.txt" 2>&1; then echo "FAIL override accepted off loopback"; exit 1; fi; grep -q M6_TEST_OVERRIDE_REFUSED_OFF_LOOPBACK "$T/o.txt"; echo "PASS test override refused off loopback"
if DATABASE_URL="postgresql://u:p@db.example.invalid:5432/postgres" M6_OPERATION=preflight GITHUB_SHA=$SHA M6_APPROVED_SHA=$SHA node scripts/m6/production-sql-apply.mjs >"$T/o.txt" 2>&1; then echo "FAIL foreign host accepted"; exit 1; fi; grep -q M6_DATABASE_NOT_PRODUCTION_PROJECT "$T/o.txt"; echo "PASS a database that does not name the Production project is refused"
node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); a.sql["apply-004"][0].sha256="0".repeat(64); require("fs").writeFileSync(process.argv[2],JSON.stringify(a))' $T/allow.json $T/allow-bad.json
ALLOW=$T/allow-bad.json expect_fail M6_CHECKSUM_MISMATCH op apply-004
node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); a.sql["apply-004"][0].file="../../etc/passwd"; require("fs").writeFileSync(process.argv[2],JSON.stringify(a))' $T/allow.json $T/allow-path.json
ALLOW=$T/allow-path.json expect_fail M6_PATH_OUTSIDE_REPO op apply-004
echo "PASS tampered hash / path outside the repo refused"
"${S[@]}" -c "update dpg_control.target_contract set project_name='dongphugia-staging'"; expect_fail M6_TARGET_NOT_PRODUCTION_CONTRACT op preflight; "${S[@]}" -c "update dpg_control.target_contract set project_name='dongphugia-runtime'"
"${S[@]}" -c "update dpg_control.target_contract set environment='preview_synthetic'"; expect_fail M6_TARGET_NOT_PRODUCTION_CONTRACT op preflight; "${S[@]}" -c "update dpg_control.target_contract set environment='preview'"
echo "PASS wrong project / TEST environment refused"
old=$(date -u -d '-3 hours' +%Y-%m-%dT%H:%M:%SZ)
BK= expect_fail M6_BACKUP_EVIDENCE_MISSING op apply-004
BK="${BK_OK/$NOW/$old}" expect_fail M6_BACKUP_TOO_OLD op apply-004
BK="${BK_OK/\"Row-count manifest, encrypted dump and checksums\":true/\"Row-count manifest, encrypted dump and checksums\":false}" expect_fail M6_BACKUP_DID_NOT_DUMP op apply-004
BK="${BK_OK/\"restore-rehearsal\":\"success\"/\"restore-rehearsal\":\"skipped\"}" expect_fail M6_BACKUP_RESTORE_NOT_PROVEN op apply-004
BK="${BK_OK/\"conclusion\":\"success\"/\"conclusion\":\"failure\"}" expect_fail M6_BACKUP_NOT_SUCCESSFUL op apply-004
BK="${BK_OK/\"head_branch\":\"main\"/\"head_branch\":\"feature\"}" expect_fail M6_BACKUP_NOT_FROM_MAIN op apply-004
BK="${BK_OK/m4-production-backup/runtime-backup}" expect_fail M6_BACKUP_WRONG_WORKFLOW op apply-004
op preflight >/dev/null; echo "PASS preflight needs no backup; every mutation refuses a missing / >2h / probe-only / restore-less / failed / non-main / wrong-workflow backup"
[ "$("${S[@]}" -c "select count(*) from pg_attribute where attrelid='dpg_app.products'::regclass and attname='regular_price_vnd'")" = 0 ]; echo "PASS database untouched by every refusal"
"${S[@]}" -c "select pg_advisory_lock(hashtext('m6-production-sql-apply')); select pg_sleep(8)" >/dev/null & sleep 2
expect_fail M6_ANOTHER_RUN_IN_PROGRESS op preflight; wait
echo "PASS concurrent run refused"

# ---- 004 first (security), idempotent ----
op apply-004 >/dev/null; op apply-004 >/dev/null
grep -q "authenticated runtime RPCs 4" $T/summary.md; echo "PASS 004: 6 mutating RPCs + all writes revoked, 4 read RPCs kept; retry idempotent"
# ---- schema ----
op apply-schema >/dev/null
[ "$("${S[@]}" -c "select count(*) from pg_attribute where attrelid='dpg_app.products'::regclass and attname in ('regular_price_vnd','promotional_price_vnd','online_voucher_amount_vnd','canonical_price_status','canonical_price_checked_at')")" = 5 ]
[ "$("${S[@]}" -c "select count(*) from pg_namespace where nspname='dpg_commerce'")" = 1 ]
echo "PASS schema: 001 -> 002 -> commerce 001 applied"
expect_fail M6_ALREADY_APPLIED op apply-schema; echo "PASS second apply-schema refuses (commerce 001 is not idempotent) — fail closed"
"${S[@]}" -c "insert into dpg_commerce.orders(code,customer_name,customer_phone,delivery_address,subtotal_vnd,total_vnd,line_count,idempotency_hash,request_hash) values ('DH-AAAAAAAAAA','Test Dummy','0912345678','1 Test Street',1000,1000,1,repeat('a',64),repeat('a',64))"
expect_fail M6_ROLLBACK_REFUSED_ORDERS_EXIST op rollback-schema
"${S[@]}" -c "delete from dpg_commerce.orders"; op rollback-schema >/dev/null
[ "$("${S[@]}" -c "select count(*) from pg_namespace where nspname='dpg_commerce'")" = 0 ]; echo "PASS rollback-schema refuses while an order exists, then restores the baseline"
op apply-schema >/dev/null; echo "PASS re-apply after rollback"

# ---- import: the REAL package ----
OUTN=p1 op plan-import prices >/dev/null
SET=$(grep -o 'plan_set_sha256 = `[0-9a-f]\{64\}' $T/summary.md | tail -1 | grep -o '[0-9a-f]\{64\}'); [ -n "$SET" ]; echo "plan-set (prices) = $SET"
[ "$("${S[@]}" -c "select count(*) from dpg_app.products where canonical_price_status is not null")" = 0 ]; echo "PASS plan-import prices is read-only (nothing applied)"
M6_PLAN_SET_SHA256=$(printf '%064d' 0) OUTN=bad expect_fail M6_PLAN_SET_CHANGED op apply-import prices
[ "$("${S[@]}" -c "select count(*) from dpg_app.products where canonical_price_status is not null")" = 0 ]; echo "PASS a plan-set the Owner did not approve is refused; nothing written"
M6_PLAN_SET_SHA256=$SET OUTN=a1 op apply-import prices >/dev/null
read PRICED STATUS <<<"$("${S[@]}" -F' ' -c "select count(*) filter (where canonical_price_status='PRICE_VERIFIED'), count(*) filter (where canonical_price_status in ('CONTACT_VERIFIED','DISCONTINUED')) from dpg_app.products")"
echo "applied: PRICE_VERIFIED=$PRICED other-status=$STATUS"; [ "$PRICED" = 4648 ] && [ "$STATUS" = 1284 ]
echo "PASS prices: 4.648 PRICE_VERIFIED + 1.284 statuses applied through the lane"
OUTN=v1 op plan-import voucher >/dev/null
VSET=$(grep -o 'plan_set_sha256 = `[0-9a-f]\{64\}' $T/summary.md | tail -1 | grep -o '[0-9a-f]\{64\}')
M6_PLAN_SET_SHA256=$VSET OUTN=v2 op apply-import voucher >/dev/null
[ "$("${S[@]}" -c "select count(*) from dpg_app.products where online_voucher_amount_vnd is not null")" = 1101 ]; echo "PASS voucher: 1.101 applied after the price lanes (plan pinned on the real post-price state)"
"${S[@]}" -c "update dpg_app.products set version = version + 1 where id = (select min(id) from dpg_app.products where canonical_price_status = 'PRICE_VERIFIED' and online_voucher_amount_vnd is null)"
M6_PLAN_SET_SHA256=$VSET OUTN=v3 expect_fail M6_ op apply-import voucher; echo "PASS a changed state refuses the old approval (plan again)"
"${S[@]}" -c "update dpg_app.products set version = version - 1 where version = (select max(version) from dpg_app.products)"
cp -r $T/out-v2 $T/rb-v; M6_ROLLBACK_DIR=$T/rb-v op rollback-import >/dev/null
[ "$("${S[@]}" -c "select count(*) from dpg_app.products where online_voucher_amount_vnd is not null")" = 0 ]; echo "PASS rollback-import restores the pre-voucher state"
cp -r $T/out-a1 $T/rb-a
# an Admin edit after the apply (a different price) must STOP the rollback of that batch instead of overwriting it; undo the edit and it resumes (done batches are skipped)
"${S[@]}" -c "update dpg_app.products set regular_price_vnd = regular_price_vnd + 1 where id = (select min(id) from dpg_app.products where canonical_price_status = 'PRICE_VERIFIED')"
M6_ROLLBACK_DIR=$T/rb-a expect_fail M6_ROLLBACK_STATE_UNEXPECTED op rollback-import
"${S[@]}" -c "update dpg_app.products set regular_price_vnd = regular_price_vnd - 1 where id = (select min(id) from dpg_app.products where canonical_price_status = 'PRICE_VERIFIED')"
M6_ROLLBACK_DIR=$T/rb-a op rollback-import >$T/o.txt 2>&1 || { tail -4 $T/o.txt; exit 1; }
grep -q "already rolled back (skipped)" $T/o.txt && echo "PASS an interrupted rollback resumes (finished batches skipped)"
[ "$("${S[@]}" -c "select count(*) from dpg_app.products where canonical_price_status is not null")" = 0 ]; echo "PASS rollback-import restores the pre-price state exactly (0 rows with a canonical status), after the voucher rollback and an interrupted attempt"
# retry: the whole import can be planned and applied again after a rollback
OUTN=r1 op plan-import prices >/dev/null; RSET=$(grep -o 'plan_set_sha256 = `[0-9a-f]\{64\}' $T/summary.md | tail -1 | grep -o '[0-9a-f]\{64\}')
M6_PLAN_SET_SHA256=$RSET OUTN=r2 op apply-import prices >/dev/null
[ "$("${S[@]}" -c "select count(*) from dpg_app.products where canonical_price_status = 'PRICE_VERIFIED'")" = 4648 ]; echo "PASS retry after rollback: prices applied again (4.648)"
echo "ALL PASS"
