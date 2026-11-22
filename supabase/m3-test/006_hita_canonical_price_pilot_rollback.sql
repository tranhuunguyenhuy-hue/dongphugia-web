-- #446: reverse the TEST schema change only after reconciling and reverting imported values.
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
    raise exception 'HITA_PRICE_PILOT_TARGET_NOT_TEST';
  end if;
  if row_security_active('dpg_app.products'::regclass) then
    raise exception 'HITA_PRICE_PILOT_ROLLBACK_REQUIRES_FULL_VISIBILITY';
  end if;
end
$$;

lock table dpg_app.products in access exclusive mode;
do $$
begin
  if exists (
    select 1 from dpg_app.products p
    where to_jsonb(p)->>'regular_price_vnd' is not null
      or to_jsonb(p)->>'promotional_price_vnd' is not null
      or to_jsonb(p)->>'online_voucher_amount_vnd' is not null
  ) then
    raise exception 'HITA_PRICE_PILOT_ROLLBACK_RECONCILE_POPULATED_VALUES_FIRST';
  end if;
end
$$;

alter table dpg_app.products
  drop constraint if exists products_hita_price_vnd_check,
  drop column if exists regular_price_vnd,
  drop column if exists promotional_price_vnd,
  drop column if exists online_voucher_amount_vnd;

commit;
