#!/usr/bin/env bash
# #470: isolated local proof that the legacy decommission keeps every row, closes every legacy object, and that the restore is exact. Usage: run-decommission-local.sh <socket-dir> <port> <superuser>
set -euo pipefail
H=${1:?host}; P=${2:?port}; U=${3:?user}; DB=dpgdc_$$; SHA=local-test-sha
cd "$(dirname "$0")/../.."
PROD=prod-prep/470; CM=commerce-v1
PSQL=(psql -X -q -tA -v ON_ERROR_STOP=1 -h "$H" -p "$P")
drop_all() { "${PSQL[@]}" -U "$U" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true
  for r in dpg_commerce_intake dpg_commerce_owner dpg_operator dpg_migration dpg_admin_api dpg_public_catalogue dpg_runtime dpg_readonly authenticated dpg_direct_import anon service_role; do "${PSQL[@]}" -U "$U" -d postgres -c "drop role if exists $r" >/dev/null 2>&1 || true; done; }
trap drop_all EXIT; drop_all
"${PSQL[@]}" -U "$U" -d postgres -c "create database $DB"
S=("${PSQL[@]}" -U "$U" -d "$DB"); M=("${PSQL[@]}" -U dpg_operator -d "$DB" -v approved_sha="$SHA" -v backup_ref=backup-0123456789abcdef)
"${S[@]}" -f $PROD/tests/fixture.sql; "${S[@]}" -f $PROD/tests/seed.sql
"${S[@]}" -c "alter role dpg_operator createrole; grant create on database $DB to dpg_operator"
"${M[@]}" -f $PROD/001_canonical_price_columns.sql >/dev/null; "${M[@]}" -f $PROD/002_canonical_price_grants.sql >/dev/null
"${M[@]}" -f $PROD/003_runtime_order_quote_canonical_rollback.sql >/dev/null            # installs the live baseline text of the two RPCs
"${S[@]}" -f $PROD/tests/acl-baseline.sql
"${S[@]}" -c "insert into dpg_app.orders(id,order_number,customer_name,customer_phone,subtotal,total,status,payment_status) values (1,'DPG-X','Legacy','0900000000',10,10,'pending','unpaid'); insert into dpg_app.order_items(order_id,product_id,product_name,product_sku,quantity,unit_price,total_price) values (1,1,'p','s',1,10,10); insert into dpg_app.quote_requests(id,name,phone,status) values (1,'Legacy Q','0900000001','pending'); insert into dpg_app.quote_items(quote_id,product_id,quantity) values (1,1,1)"
ACL0=$("${S[@]}" -f $PROD/tests/acl-snapshot.sql); ROWS0=$("${S[@]}" -c "select (select count(*) from dpg_app.orders)||'/'||(select count(*) from dpg_app.order_items)||'/'||(select count(*) from dpg_app.quote_requests)||'/'||(select count(*) from dpg_app.quote_items)")
MD0=$("${S[@]}" -c "select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.oid::regprocedure::text)) from pg_proc p where (p.pronamespace='public'::regnamespace and p.proname ~ '^runtime_(order|quote)_') or (p.pronamespace='dpg_app'::regnamespace and p.proname in ('runtime_hash','runtime_key_hash'))")
# guards: no backup reference / replacement missing / wrong target
if "${PSQL[@]}" -U dpg_operator -d "$DB" -v approved_sha=$SHA -v backup_ref= -f $CM/002_decommission_legacy.sql >/dev/null 2>&1; then echo "FAIL: ran without a backup reference"; exit 1; fi
if "${M[@]}" -f $CM/002_decommission_legacy.sql >/dev/null 2>&1; then echo "FAIL: ran before commerce v1 exists"; exit 1; fi
echo "PASS decommission refuses without a backup reference and before the replacement (commerce v1) exists"
"${PSQL[@]}" -U dpg_operator -d "$DB" -v approved_sha=$SHA -v target=production -v admin_role=dpg_admin_api -f $CM/001_commerce_schema.sql
"${S[@]}" -c "update dpg_control.target_contract set project_name='dongphugia-staging'"
if "${M[@]}" -f $CM/002_decommission_legacy.sql >/dev/null 2>&1; then echo "FAIL: ran on a foreign project"; exit 1; fi
"${S[@]}" -c "update dpg_control.target_contract set project_name='dongphugia-runtime'"
"${M[@]}" -f $CM/002_decommission_legacy.sql
echo "PASS decommission applied"
[ "$("${S[@]}" -c "select (select count(*) from dpg_legacy_commerce.orders)||'/'||(select count(*) from dpg_legacy_commerce.order_items)||'/'||(select count(*) from dpg_legacy_commerce.quote_requests)||'/'||(select count(*) from dpg_legacy_commerce.quote_items)")" = "$ROWS0" ] || { echo "FAIL: rows lost"; exit 1; }
[ "$("${S[@]}" -c "select to_regclass('dpg_app.orders') is null and to_regclass('dpg_app.quote_requests') is null and not exists (select 1 from pg_proc p where p.proname ~ '^runtime_(order|quote)_(create|get|list|update|delete)$')")" = "t" ]
# a self-registered user can no longer reach ANY legacy object (rpc, tables, archive)
"${S[@]}" <<'SQL'
create function pg_temp.denied(stmt text) returns void language plpgsql as $$ begin begin execute stmt; exception when insufficient_privilege or undefined_table or undefined_function or invalid_schema_name then return; end; raise exception 'ASSERT FAILED (reachable): %', stmt; end $$;
set role authenticated;
select pg_temp.denied($$select public.runtime_order_create('{}'::jsonb,'idem-12345678',null)$$);
select pg_temp.denied('select * from dpg_app.orders');
select pg_temp.denied('select * from dpg_legacy_commerce.orders');
select pg_temp.denied('insert into dpg_legacy_commerce.orders(id,order_number,customer_name,customer_phone,status,payment_status) values (2,''x'',''x'',''0900000000'',''p'',''u'')');
select pg_temp.denied('select * from dpg_legacy_commerce.function_definitions');
SQL
echo "PASS every legacy entrypoint is unreachable for authenticated (RPCs gone, tables archived, archive closed); all rows intact"
if "${M[@]}" -f $CM/002_decommission_legacy.sql >/dev/null 2>&1; then echo "FAIL: second run accepted"; exit 1; fi
"${M[@]}" -f $CM/002_decommission_legacy_restore.sql
[ "$("${S[@]}" -f $PROD/tests/acl-snapshot.sql)" = "$ACL0" ] || { echo "FAIL: restore did not give back the exact ACL"; exit 1; }
[ "$("${S[@]}" -c "select (select count(*) from dpg_app.orders)||'/'||(select count(*) from dpg_app.order_items)||'/'||(select count(*) from dpg_app.quote_requests)||'/'||(select count(*) from dpg_app.quote_items)")" = "$ROWS0" ]
[ "$("${S[@]}" -c "select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.oid::regprocedure::text)) from pg_proc p where (p.pronamespace='public'::regnamespace and p.proname ~ '^runtime_(order|quote)_') or (p.pronamespace='dpg_app'::regnamespace and p.proname in ('runtime_hash','runtime_key_hash'))")" = "$MD0" ] || { echo "FAIL: function definitions differ after restore"; exit 1; }
"${S[@]}" -f $PROD/tests/assert-baseline.sql
echo "PASS restore is exact: rows, function text (md5 of definitions + live baseline md5), owners' ACL byte-for-byte"
echo "ALL PASS"
