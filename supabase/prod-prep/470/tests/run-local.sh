#!/usr/bin/env bash
# #470: isolated local PostgreSQL proof of 001/002/003 (+rollbacks). Never point this at a hosted project.
# Usage: run-local.sh <host-or-socket-dir> <port> <superuser>
set -euo pipefail
H=${1:?host}; P=${2:?port}; U=${3:?user}; DB=dpg470_$$; SHA=local-test-sha
cd "$(dirname "$0")/.."
PSQL=(psql -X -q -tA -v ON_ERROR_STOP=1 -h "$H" -p "$P")
drop_all() { "${PSQL[@]}" -U "$U" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true
  for r in dpg_operator dpg_migration dpg_admin_api dpg_public_catalogue dpg_runtime dpg_readonly authenticated dpg_direct_import anon service_role; do "${PSQL[@]}" -U "$U" -d postgres -c "drop role if exists $r" >/dev/null 2>&1 || true; done; }
trap drop_all EXIT; drop_all
"${PSQL[@]}" -U "$U" -d postgres -c "create database $DB"
S=("${PSQL[@]}" -U "$U" -d "$DB"); M=("${PSQL[@]}" -U dpg_operator -d "$DB" -v approved_sha="$SHA")
"${S[@]}" -f tests/fixture.sql
"${S[@]}" -f tests/seed.sql
"${S[@]}" -f tests/seed-scope.sql
# baseline function text = the rollback file's text, installed as the owner (the live definition from Production)
"${M[@]}" -f 003_runtime_order_quote_canonical_rollback.sql
"${S[@]}" -f tests/assert-baseline.sql
echo "PASS baseline md5 equals the live Production md5 (transcription is byte-exact)"
"${S[@]}" -f tests/acl-baseline.sql
ACL0=$("${S[@]}" -f tests/acl-snapshot.sql)
# --- guards refuse without approval / on wrong target ---
if psql -X -q -v ON_ERROR_STOP=1 -h "$H" -p "$P" -U dpg_operator -d "$DB" -v approved_sha= -f 001_canonical_price_columns.sql >/dev/null 2>&1; then echo "FAIL: 001 ran without approval"; exit 1; fi
echo "PASS 001 refuses an empty approval"
"${S[@]}" -c "update dpg_control.target_contract set environment='preview_synthetic'"
if "${M[@]}" -f 001_canonical_price_columns.sql >/dev/null 2>&1; then echo "FAIL: 001 ran on a TEST contract"; exit 1; fi
"${S[@]}" -c "update dpg_control.target_contract set environment='preview'"
echo "PASS 001 refuses a preview_synthetic (TEST) contract"
"${S[@]}" -c "update dpg_control.target_contract set project_name='dongphugia-staging'"
for f in 001_canonical_price_columns 002_canonical_price_grants 003_runtime_order_quote_canonical; do
  if "${M[@]}" -f $f.sql >/dev/null 2>&1; then echo "FAIL: $f ran on a non-Production project identity"; exit 1; fi; done
"${S[@]}" -c "update dpg_control.target_contract set project_name='dongphugia-runtime'"
echo "PASS 001/002/003 refuse any other project identity (exact project/region/environment/ceiling, not just 'not TEST')"
# --- 001 + 002 (idempotent) ---
"${M[@]}" -f 001_canonical_price_columns.sql; "${M[@]}" -f 001_canonical_price_columns.sql
"${M[@]}" -f 002_canonical_price_grants.sql;  "${M[@]}" -f 002_canonical_price_grants.sql
echo "PASS 001/002 apply and are idempotent"
"${S[@]}" -f tests/assert-schema.sql
echo "PASS schema + CHECK + column ACL assertions"
"${M[@]}" -f 003_runtime_order_quote_canonical.sql
echo "PASS 003 applies on the exact baseline"
"${S[@]}" -f tests/assert-behaviour.sql
echo "PASS canonical order/quote behaviour (TOTO+INAX scope; other sanitary brand and other categories legacy; inactive/unresolved/out-of-stock never priced)"
# --- commerce lock (004): before it the direct entrypoints are open (baseline); after it every one is closed; rollback restores the exact baseline ACL ---
if "${S[@]}" -f tests/assert-lock.sql >/dev/null 2>&1; then echo "FAIL: baseline unexpectedly has no direct entrypoint (test would prove nothing)"; exit 1; fi
echo "PASS control: on the live baseline ACL the direct RPC/table entrypoints ARE open (lock test is meaningful)"
if psql -X -q -v ON_ERROR_STOP=1 -h "$H" -p "$P" -U dpg_operator -d "$DB" -v approved_sha= -f 004_commerce_direct_access_lock.sql >/dev/null 2>&1; then echo "FAIL: 004 ran without approval"; exit 1; fi
"${S[@]}" -c "update dpg_control.target_contract set project_name='dongphugia-staging'"
if "${M[@]}" -f 004_commerce_direct_access_lock.sql >/dev/null 2>&1; then echo "FAIL: 004 ran on a non-Production identity"; exit 1; fi
"${S[@]}" -c "update dpg_control.target_contract set project_name='dongphugia-runtime'"
"${M[@]}" -f 004_commerce_direct_access_lock.sql; "${M[@]}" -f 004_commerce_direct_access_lock.sql
echo "PASS 004 refuses empty approval / foreign project; applies and is idempotent"
"${S[@]}" -f tests/assert-lock.sql
echo "PASS authenticated direct RPC + PostgREST table writes + sequence are all denied; reads, anon and service_role as expected"
"${M[@]}" -f 004_commerce_direct_access_lock_rollback.sql
[ "$("${S[@]}" -f tests/acl-snapshot.sql)" = "$ACL0" ] || { echo "FAIL: 004 rollback did not restore the exact baseline ACL"; exit 1; }
echo "PASS 004 rollback restores the exact baseline ACL (byte-for-byte)"
"${M[@]}" -f 004_commerce_direct_access_lock.sql
# --- rollback chain ---
if "${M[@]}" -f 001_canonical_price_columns_rollback.sql >/dev/null 2>&1; then echo "FAIL: 001 rollback ran with populated values"; exit 1; fi
echo "PASS 001 rollback refuses while values are populated"
"${S[@]}" -c "update dpg_app.products set regular_price_vnd=null, promotional_price_vnd=null, online_voucher_amount_vnd=null, canonical_price_status=null, canonical_price_checked_at=null"
"${M[@]}" -f 003_runtime_order_quote_canonical_rollback.sql
"${S[@]}" -f tests/assert-baseline.sql
"${M[@]}" -f 002_canonical_price_grants_rollback.sql
"${M[@]}" -f 001_canonical_price_columns_rollback.sql
"${S[@]}" -c "do \$\$ begin if exists (select 1 from information_schema.columns where table_schema='dpg_app' and table_name='products' and column_name in ('regular_price_vnd','promotional_price_vnd','online_voucher_amount_vnd','canonical_price_status','canonical_price_checked_at')) then raise exception 'rollback left columns'; end if; end \$\$"
echo "PASS full rollback restores baseline functions + schema"
echo "ALL PASS"
