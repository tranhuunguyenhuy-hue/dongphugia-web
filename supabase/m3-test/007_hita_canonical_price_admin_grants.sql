-- #446 (Claude, Backend/Infra lane): column-level grants for the three canonical price columns, TEST ONLY.
-- Previous ACL of the function owner on products.category_id and categories(id,slug): none (captured 23/11/2026).
-- Previous ACL of the three columns (captured read-only 23/11/2026 on ref uybumsnyqpwcidjxmfsv): NULL (no grants).
-- Additive and idempotent. Touches only regular_price_vnd / promotional_price_vnd / online_voucher_amount_vnd.
-- No role, RLS policy, trigger or function is changed. Rollback: 007_hita_canonical_price_admin_grants_rollback.sql.
begin;
set local lock_timeout = '5s';

do $$
begin
  -- guard:begin
  if not exists (
    select 1 from dpg_control.target_contract
    where environment = 'preview_synthetic'
      and production_writes_allowed = false
      and production_data_allowed = false
      and production_credentials_allowed = false
  ) then
    raise exception 'HITA_PRICE_GRANTS_TARGET_NOT_TEST';
  end if;
  -- guard:end
  if (select count(*) from pg_attribute
      where attrelid = 'dpg_app.products'::regclass and not attisdropped
        and attname in ('regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd')) <> 3 then
    raise exception 'HITA_PRICE_GRANTS_COLUMNS_MISSING';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'dpg_admin_api_test') then
    raise exception 'HITA_PRICE_GRANTS_ROLE_MISSING';
  end if;
end
$$;

grant select (regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd) on dpg_app.products to dpg_admin_api_test;
grant insert (regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd) on dpg_app.products to dpg_admin_api_test;
grant update (regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd) on dpg_app.products to dpg_admin_api_test;

-- The guest order intake function reads product prices; it needs the canonical columns to snapshot the voucher once.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'dpg_order_intake_function_owner') then
    execute 'grant select (regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd, category_id) on dpg_app.products to dpg_order_intake_function_owner';
    execute 'grant select (id, slug) on dpg_app.categories to dpg_order_intake_function_owner';
  end if;
end
$$;

commit;
