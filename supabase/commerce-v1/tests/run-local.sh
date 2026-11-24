#!/usr/bin/env bash
# #470 commerce v1: isolated local PostgreSQL proof (never a hosted project). Usage: run-local.sh <socket-dir> <port> <superuser>
set -euo pipefail
H=${1:?host}; P=${2:?port}; U=${3:?user}; DB=dpgcm_$$; SHA=local-test-sha
cd "$(dirname "$0")/../.."
PROD=prod-prep/470; CM=commerce-v1
PSQL=(psql -X -q -tA -v ON_ERROR_STOP=1 -h "$H" -p "$P")
drop_all() { "${PSQL[@]}" -U "$U" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true
  for r in dpg_commerce_intake dpg_commerce_owner dpg_operator dpg_migration dpg_admin_api dpg_public_catalogue dpg_runtime dpg_readonly authenticated dpg_direct_import anon service_role; do "${PSQL[@]}" -U "$U" -d postgres -c "drop role if exists $r" >/dev/null 2>&1 || true; done; }
trap drop_all EXIT; drop_all
"${PSQL[@]}" -U "$U" -d postgres -c "create database $DB"
S=("${PSQL[@]}" -U "$U" -d "$DB"); M=("${PSQL[@]}" -U dpg_operator -d "$DB" -v approved_sha="$SHA")
"${S[@]}" -f $PROD/tests/fixture.sql; "${S[@]}" -f $PROD/tests/seed.sql; "${S[@]}" -f $PROD/tests/seed-scope.sql
"${S[@]}" -c "alter role dpg_operator createrole; grant create on database $DB to dpg_operator"
"${M[@]}" -f $PROD/001_canonical_price_columns.sql; "${M[@]}" -f $PROD/002_canonical_price_grants.sql
# the commerce schema refuses without approval / on a foreign target / without the price columns
if "${PSQL[@]}" -U dpg_operator -d "$DB" -v approved_sha= -v target=production -v admin_role=dpg_admin_api -f $CM/001_commerce_schema.sql >/dev/null 2>&1; then echo "FAIL: ran without approval"; exit 1; fi
if "${PSQL[@]}" -U dpg_operator -d "$DB" -v approved_sha=$SHA -v target=test -v admin_role=dpg_admin_api -f $CM/001_commerce_schema.sql >/dev/null 2>&1; then echo "FAIL: ran with the TEST target on a Production contract"; exit 1; fi
"${S[@]}" -c "update dpg_control.target_contract set project_name='dongphugia-staging'"
if "${PSQL[@]}" -U dpg_operator -d "$DB" -v approved_sha=$SHA -v target=production -v admin_role=dpg_admin_api -f $CM/001_commerce_schema.sql >/dev/null 2>&1; then echo "FAIL: ran on a foreign project"; exit 1; fi
"${S[@]}" -c "update dpg_control.target_contract set project_name='dongphugia-runtime'"
echo "PASS commerce schema refuses an empty approval, a wrong target and a foreign project identity"
"${PSQL[@]}" -U dpg_operator -d "$DB" -v approved_sha=$SHA -v target=production -v admin_role=dpg_admin_api -f $CM/001_commerce_schema.sql
echo "PASS commerce schema applies (owner/intake roles, 6 tables, 3 entry points)"
# canonical test data: ids from seed(.sql/-scope): 1 TOTO 1.0M | 2 TOTO 2.0M promo 1.8M voucher 100k | 3 no status | 4 CONTACT | 5 other category | 6 out of stock | 7 INAX 1.5M promo 1.4M voucher 50k | 8 other sanitary brand | 9 inactive priced | 10 INAX unresolved
"${S[@]}" -c "
update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=1000000, canonical_price_checked_at=now() where sku='VS-OK';
update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=2000000, promotional_price_vnd=1800000, online_voucher_amount_vnd=100000, canonical_price_checked_at=now() where sku='VS-PROMO';
update dpg_app.products set canonical_price_status='CONTACT_VERIFIED', canonical_price_checked_at=now() where sku='VS-CONTACT';
update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=1500000, promotional_price_vnd=1400000, online_voucher_amount_vnd=50000, canonical_price_checked_at=now() where sku='VS-INAX';
update dpg_app.products set canonical_price_status='UNRESOLVED', canonical_price_checked_at=now() where sku='VS-INAX-UNRES';
update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=1200000, canonical_price_checked_at=now() where sku='VS-INACTIVE';"
"${S[@]}" -f $CM/tests/assert-commerce.sql
echo "PASS commerce behaviour: cart check, order (3 prices, voucher once x qty, snapshot), quote, mixed cart, price change, idempotency, validation, rate limit, privacy, staff status machine"
if "${PSQL[@]}" -U dpg_operator -d "$DB" -v approved_sha=$SHA -v target=production -f $CM/001_commerce_schema_rollback.sql >/dev/null 2>&1; then echo "FAIL: rollback ran over existing orders"; exit 1; fi
echo "PASS rollback refuses while orders/quotes exist (no data loss: export first)"
"${S[@]}" -c "set session_replication_role = replica; delete from dpg_commerce.events; delete from dpg_commerce.order_lines; delete from dpg_commerce.quote_lines; delete from dpg_commerce.orders; delete from dpg_commerce.quotes"
"${PSQL[@]}" -U dpg_operator -d "$DB" -v approved_sha=$SHA -v target=production -f $CM/001_commerce_schema_rollback.sql
[ "$("${S[@]}" -c "select to_regnamespace('dpg_commerce') is null and not exists (select 1 from pg_roles where rolname in ('dpg_commerce_owner','dpg_commerce_intake')) and not exists (select 1 from pg_policy where polname='dpg_commerce_owner_select')")" = "t" ]
echo "PASS rollback (empty) removes schema, roles and the three policies"
"${PSQL[@]}" -U dpg_operator -d "$DB" -v approved_sha=$SHA -v target=production -v admin_role=dpg_admin_api -f $CM/001_commerce_schema.sql
echo "PASS commerce schema re-applies cleanly after rollback"
echo "ALL PASS"
