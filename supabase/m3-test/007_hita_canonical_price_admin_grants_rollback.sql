-- #446: exact reverse of 007 (previous ACL of the three columns was NULL). Grants only; data and schema untouched.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (
    select 1 from dpg_control.target_contract
    where environment = 'preview_synthetic'
      and production_writes_allowed = false
      and production_data_allowed = false
      and production_credentials_allowed = false
  ) then
    raise exception 'HITA_PRICE_GRANTS_TARGET_NOT_TEST';
  end if;
end
$$;

revoke select (regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd) on dpg_app.products from dpg_admin_api_test;
revoke insert (regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd) on dpg_app.products from dpg_admin_api_test;
revoke update (regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd) on dpg_app.products from dpg_admin_api_test;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'dpg_order_intake_function_owner') then
    execute 'revoke select (regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd, category_id) on dpg_app.products from dpg_order_intake_function_owner';
    execute 'revoke select (id, slug) on dpg_app.categories from dpg_order_intake_function_owner';
  end if;
end
$$;

commit;
