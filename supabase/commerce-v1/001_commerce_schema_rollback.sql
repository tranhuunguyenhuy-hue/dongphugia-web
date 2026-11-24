-- #470 COMMERCE V1 rollback: removes the new schema, roles' privileges and the three narrow policies. REFUSES while any order/quote exists (no data loss): export/restore first.
-- psql -v ON_ERROR_STOP=1 -v approved_sha=<sha> -v target=production|test -v admin_role=<role> -f 001_commerce_schema_rollback.sql
begin;
set local lock_timeout = '5s';
select set_config('dpg.commerce_go', :'approved_sha', true), set_config('dpg.commerce_target', :'target', true);
do $$ begin
  if coalesce(current_setting('dpg.commerce_go', true), '') = '' then raise exception 'COMMERCE_NO_OWNER_GO'; end if;
  if current_setting('dpg.commerce_target', true) = 'production' and not exists (select 1 from dpg_control.target_contract where project_name = 'dongphugia-runtime' and region = 'ap-southeast-1' and environment = 'preview' and hard_database_ceiling_bytes = 367001600) then raise exception 'COMMERCE_TARGET_NOT_PRODUCTION_CONTRACT'; end if;
  if current_setting('dpg.commerce_target', true) = 'test' and not exists (select 1 from dpg_control.target_contract where project_name = 'dongphugia-phase2-preview-290' and environment = 'preview_synthetic') then raise exception 'COMMERCE_TARGET_NOT_TEST_CONTRACT'; end if;
end $$;
grant dpg_commerce_owner to current_user;   -- membership needed to read the (RLS-protected) tables for the safety check and to drop the schema
set local role dpg_commerce_owner;
do $$ begin
  if (select count(*) from dpg_commerce.orders) + (select count(*) from dpg_commerce.quotes) > 0 then raise exception 'COMMERCE_ROLLBACK_REFUSED_DATA_PRESENT_EXPORT_FIRST'; end if;
end $$;
reset role;
drop policy if exists dpg_commerce_owner_select on dpg_app.products;
drop policy if exists dpg_commerce_owner_select on dpg_app.brands;
drop policy if exists dpg_commerce_owner_select on dpg_app.categories;
drop schema if exists dpg_commerce cascade;
revoke select (id, sku, name, is_active, publication_status, pdp_visibility, sellable_status, stock_status, category_id, brand_id, regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd, canonical_price_status) on dpg_app.products from dpg_commerce_owner;
revoke select (id, slug, name) on dpg_app.brands from dpg_commerce_owner;
revoke select (id, slug) on dpg_app.categories from dpg_commerce_owner;
revoke usage on schema dpg_app from dpg_commerce_owner;
drop role if exists dpg_commerce_intake;
drop role if exists dpg_commerce_owner;
commit;
