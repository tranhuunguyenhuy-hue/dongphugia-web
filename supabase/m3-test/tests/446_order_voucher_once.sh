#!/usr/bin/env bash
# #446: isolated local PostgreSQL proof that 007/008/009 (TEST) deduct the online voucher exactly once and keep other
# categories on the legacy branch; also proves rollback. Never point this at a hosted project.
# Usage: 446_order_voucher_once.sh <host-or-socket-dir> <port> <user>
set -euo pipefail
H=${1:?host}; P=${2:?port}; U=${3:?user}; DB=dpg446_$$
cd "$(dirname "$0")/../../.."
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$H" -p "$P" -U "$U")
drop_roles() { "${PSQL[@]}" -d postgres -c "drop role if exists dpg_admin_api_test" -c "drop role if exists dpg_order_intake_function_owner" -c "drop role if exists dpg_order_intake_login" -c "drop role if exists dpg_order_intake" >/dev/null 2>&1 || true; }
trap '"${PSQL[@]}" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true; drop_roles' EXIT
drop_roles
"${PSQL[@]}" -d postgres -c "create database $DB"
Q=("${PSQL[@]}" -d "$DB")
# The hosted function owner is a NON-superuser: function files run as that role so FORCE RLS and grants apply to it.
Qo=(env PGOPTIONS="-c role=dpg_order_intake_function_owner" "${Q[@]}")
"${Q[@]}" -f supabase/m3-test/tests/446_synthetic_fixture.sql
"${Q[@]}" -f supabase/m3-test/006_hita_canonical_price_pilot.sql
# Hosted state before 007/008/009: owner holds only the legacy column grants, products has an owner policy, categories has NONE (FORCE RLS).
"${Q[@]}" <<'SQL'
grant usage on schema public, dpg_app, dpg_control to dpg_order_intake_function_owner;
grant create on schema public to dpg_order_intake_function_owner;
grant select on dpg_control.target_contract to dpg_order_intake_function_owner;
grant execute on all functions in schema dpg_control, dpg_app to dpg_order_intake_function_owner;
grant select (id, sku, name, price, original_price, list_price, sale_price, online_discount_amount, stock_status, price_source, source_system,
  price_state, price_confidence, price_updated_at, is_active, publication_status, pdp_visibility, sellable_status) on dpg_app.products to dpg_order_intake_function_owner;
grant select, insert, update, delete on dpg_app.orders, dpg_app.order_items, dpg_app.guest_order_idempotency_records, dpg_app.guest_order_rate_limit_windows to dpg_order_intake_function_owner;
grant usage on all sequences in schema dpg_app to dpg_order_intake_function_owner;
alter table dpg_app.products enable row level security; alter table dpg_app.products force row level security;
create policy phase2_guest_products_select_public on dpg_app.products for select to dpg_order_intake_function_owner using (is_active);
alter table dpg_app.categories enable row level security; alter table dpg_app.categories force row level security;
SQL
"${Qo[@]}" -f supabase/m3-test/008_hita_canonical_order_voucher_rollback.sql   # installs the ORIGINAL function definition (owned by the non-superuser owner)
"${Q[@]}" <<'SQL'
create function pg_temp.assert(cond bool, msg text) returns void language plpgsql as $$ begin if not cond then raise exception 'ASSERT FAILED: %', msg; end if; end $$;
insert into dpg_app.products(id,sku,name,category_id,price,list_price,sale_price,original_price,online_discount_amount,stock_status,price_source,source_system,price_state,price_confidence,price_updated_at,regular_price_vnd,promotional_price_vnd,online_voucher_amount_vnd) values
 (1,'VS-1','VS canonical',(select id from dpg_app.categories where slug='thiet-bi-ve-sinh'),null,null,null,null,null,'in_stock',null,null,null,null,null,1000000,900000,50000),
 (2,'VS-2','VS legacy only',(select id from dpg_app.categories where slug='thiet-bi-ve-sinh'),700000,700000,null,700000,10000,'in_stock','hita','hita','priced','high','2026-07-02T00:00:00Z',null,null,null),
 (3,'GL-1','Gach legacy',(select id from dpg_app.categories where slug='gach-op-lat'),500000,500000,null,500000,20000,'in_stock','hita','hita','priced','high','2026-07-02T00:00:00Z',null,null,null);
select pg_temp.assert(public.guest_order_request_create('{"customer_name":"T","customer_phone":"0900000001","items":[{"productId":1,"sku":"VS-1","quantity":1}]}','before-key-0001')->>'error'='PRODUCT_REQUIRES_QUOTE','PRE-008 gap: canonical-only SKU must be quote-only under the old function');
SQL
echo "PASS pre-008 gap confirmed"
"${Q[@]}" -f supabase/m3-test/007_hita_canonical_price_admin_grants.sql
"${Q[@]}" -f supabase/m3-test/007_hita_canonical_price_admin_grants.sql   # idempotent
"${Qo[@]}" -f supabase/m3-test/008_hita_canonical_order_voucher.sql
"${Qo[@]}" -f supabase/m3-test/008_hita_canonical_order_voucher.sql         # idempotent
# Without 009 the owner sees no category under FORCE RLS: the canonical branch is skipped (Fixed Staging run 59 failure).
"${Q[@]}" <<'SQL'
create function pg_temp.assert(cond bool, msg text) returns void language plpgsql as $$ begin if not cond then raise exception 'ASSERT FAILED: %', msg; end if; end $$;
select pg_temp.assert(public.guest_order_request_create('{"customer_name":"T","customer_phone":"0900000011","items":[{"productId":1,"sku":"VS-1","quantity":1}]}','rls-gap-key-0001')->>'error'='PRODUCT_REQUIRES_QUOTE','RLS gap reproduced: owner cannot see categories');
SQL
echo "PASS RLS gap reproduced (008 without 009: canonical SKU still quote-only)"
"${Q[@]}" -f supabase/m3-test/009_hita_order_intake_categories_rls.sql
"${Q[@]}" -f supabase/m3-test/009_hita_order_intake_categories_rls.sql     # idempotent
"${Q[@]}" <<'SQL'
create function pg_temp.assert(cond bool, msg text) returns void language plpgsql as $$ begin if not cond then raise exception 'ASSERT FAILED: %', msg; end if; end $$;
create function pg_temp.mk(phone text, k text, items jsonb) returns jsonb language sql as
 $$ select public.guest_order_request_create(jsonb_build_object('customer_name','T','customer_phone',phone,'items',items),k) $$;
-- 1) canonical vệ sinh x2: voucher x qty once, at order level only
select pg_temp.assert((pg_temp.mk('0900000002','key-canon-0001','[{"productId":1,"sku":"VS-1","quantity":2}]')->>'order_number') is not null,'canonical order created');
select pg_temp.assert((select subtotal=1800000 and discount=100000 and total=1700000 from dpg_app.orders order by id desc limit 1),'order totals 1.8M/-100k/1.7M');
select pg_temp.assert((select unit_price=900000 and total_price=1800000 and (commercial_snapshot->>'final_unit_price')::numeric=850000 and (commercial_snapshot->>'online_voucher_amount_vnd')::numeric=50000 and commercial_snapshot->>'price_contract'='canonical_vnd_v1' from dpg_app.order_items order by id desc limit 1),'line snapshot pre-voucher unit + final 850k');
-- 2) idempotent replay never creates/discounts again
select pg_temp.mk('0900000002','key-canon-0001','[{"productId":1,"sku":"VS-1","quantity":2}]');
select pg_temp.assert((select count(*) from dpg_app.orders)=1,'replay did not create a second order');
-- 3) vệ sinh SKU with only legacy price: NO fallback
select pg_temp.assert(pg_temp.mk('0900000003','key-nolegacy-01','[{"productId":2,"sku":"VS-2","quantity":1}]')->>'error'='PRODUCT_REQUIRES_QUOTE','no legacy fallback for vệ sinh');
-- 4) other category untouched legacy branch (voucher 20k once)
select pg_temp.mk('0900000004','key-legacy-0001','[{"productId":3,"sku":"GL-1","quantity":1}]');
select pg_temp.assert((select subtotal=500000 and discount=20000 and total=480000 from dpg_app.orders order by id desc limit 1),'legacy category unchanged');
-- 5) mixed cart
select pg_temp.mk('0900000005','key-mixed-0001','[{"productId":1,"sku":"VS-1","quantity":1},{"productId":3,"sku":"GL-1","quantity":3}]');
select pg_temp.assert((select subtotal=2400000 and discount=110000 and total=2290000 from dpg_app.orders order by id desc limit 1),'mixed cart 900k+1.5M, -50k-60k');
-- 6) reconciliation: order total = sum(line total) - discount; discount = sum(voucher*qty)
select pg_temp.assert(not exists (select 1 from dpg_app.orders o where o.total <> (select sum(total_price) from dpg_app.order_items i where i.order_id=o.id) - o.discount),'orders.total reconciles');
select pg_temp.assert(not exists (select 1 from dpg_app.orders o where o.discount <> (select sum(coalesce((commercial_snapshot->>'online_voucher_amount_vnd')::numeric,(commercial_snapshot->>'online_discount_amount')::numeric,0)*quantity) from dpg_app.order_items i where i.order_id=o.id)),'discount = sum(voucher*qty)');
-- 7) grants
select pg_temp.assert(has_column_privilege('dpg_admin_api_test','dpg_app.products','regular_price_vnd','update') and has_column_privilege('dpg_admin_api_test','dpg_app.products','online_voucher_amount_vnd','insert'),'admin grants');
SQL
echo "PASS post-008: voucher once x qty, replay, no legacy fallback, other category, mixed cart, reconcile"
# Hosted role model (#446): the login role has SET but NOT INHERIT on the intake role, and EXECUTE belongs to the intake role only.
"${Q[@]}" <<'SQL'
create role dpg_order_intake nologin;
create role dpg_order_intake_login login noinherit;
grant dpg_order_intake to dpg_order_intake_login with inherit false, set true;
revoke all on function public.guest_order_request_create(jsonb, text, uuid) from public;
grant execute on function public.guest_order_request_create(jsonb, text, uuid) to dpg_order_intake;
grant usage on schema public to dpg_order_intake, dpg_order_intake_login;
set role dpg_order_intake_login;
-- Direct call must fail (the bug seen on Fixed Staging run 58: "permission denied for function").
do $$ begin
  perform public.guest_order_request_create('{}'::jsonb, 'direct-key-0001', null);
  raise exception 'SHOULD_HAVE_FAILED';
exception when insufficient_privilege then null; end $$;
-- The application path: one transaction, SET LOCAL ROLE, RPC, COMMIT.
begin;
set local role dpg_order_intake;
select public.guest_order_request_create('{"customer_name":"T","customer_phone":"0900000077","items":[{"productId":1,"sku":"VS-1","quantity":1}]}'::jsonb, 'login-key-00001', null) ->> 'order_number' is not null as created \gset
commit;
reset role;
select (:'created')::boolean and (select count(*) = 1 from dpg_app.orders where customer_phone = '0900000077' and discount = 50000 and total = 850000) as ok \gset
select 1 / (case when :'ok'::boolean then 1 else 0 end) as login_role_path; -- division by zero (script fails) when the order was not created correctly
SQL
echo "PASS login role (SET only, no INHERIT): direct EXECUTE denied, BEGIN/SET LOCAL ROLE/RPC/COMMIT creates the order"
"${Qo[@]}" -f supabase/m3-test/008_hita_canonical_order_voucher_rollback.sql
"${Q[@]}" -f supabase/m3-test/009_hita_order_intake_categories_rls_rollback.sql
"${Q[@]}" -f supabase/m3-test/009_hita_order_intake_categories_rls_rollback.sql
"${Q[@]}" -f supabase/m3-test/007_hita_canonical_price_admin_grants_rollback.sql
"${Q[@]}" -f supabase/m3-test/007_hita_canonical_price_admin_grants_rollback.sql
"${Q[@]}" <<'SQL'
create function pg_temp.assert(cond bool, msg text) returns void language plpgsql as $$ begin if not cond then raise exception 'ASSERT FAILED: %', msg; end if; end $$;
select pg_temp.assert(not has_column_privilege('dpg_admin_api_test','dpg_app.products','regular_price_vnd','select'),'grants revoked');
select pg_temp.assert(public.guest_order_request_create('{"customer_name":"T","customer_phone":"0900000009","items":[{"productId":1,"sku":"VS-1","quantity":1}]}','after-key-00001')->>'error'='PRODUCT_REQUIRES_QUOTE','rollback restores original function');
SQL
echo "PASS rollback 008+007 (twice) restores original behaviour and ACL"
