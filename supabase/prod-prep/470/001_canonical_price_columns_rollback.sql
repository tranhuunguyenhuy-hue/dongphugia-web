-- #470 DRAFT — rollback of 001. Refuses when any canonical value is populated: restore from the pre-import ledger first.
-- Worker rollback does not undo this SQL; this SQL does not undo Worker rollback.
begin;
set local lock_timeout = '5s';
select set_config('dpg.price_release_go', :'approved_sha', true);
do $$
begin
  if coalesce(current_setting('dpg.price_release_go', true), '') = '' then raise exception 'PRICE_RELEASE_NO_OWNER_GO'; end if;
  if not exists (select 1 from dpg_control.target_contract where environment <> 'preview_synthetic' and hard_database_ceiling_bytes = 367001600) then
    raise exception 'PRICE_RELEASE_TARGET_NOT_PRODUCTION_CONTRACT';
  end if;
end
$$;
lock table dpg_app.products in access exclusive mode;
do $$
begin
  if exists (
    select 1 from dpg_app.products p
    where p.regular_price_vnd is not null or p.promotional_price_vnd is not null or p.online_voucher_amount_vnd is not null
       or p.canonical_price_status is not null or p.canonical_price_checked_at is not null
  ) then
    raise exception 'PRICE_RELEASE_ROLLBACK_RECONCILE_POPULATED_VALUES_FIRST';
  end if;
end
$$;
alter table dpg_app.products
  drop constraint if exists products_canonical_price_check,
  drop column if exists regular_price_vnd,
  drop column if exists promotional_price_vnd,
  drop column if exists online_voucher_amount_vnd,
  drop column if exists canonical_price_status,
  drop column if exists canonical_price_checked_at;
commit;
