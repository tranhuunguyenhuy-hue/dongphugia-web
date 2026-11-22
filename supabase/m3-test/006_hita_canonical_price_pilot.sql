-- #446: additive schema for the isolated TEST pricing pilot.
-- Verify the immutable Supabase project ref and restore evidence before applying.
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
end
$$;

alter table dpg_app.products
  add column if not exists regular_price_vnd bigint,
  add column if not exists promotional_price_vnd bigint,
  add column if not exists online_voucher_amount_vnd bigint;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'dpg_app' and table_name = 'products'
      and column_name in ('regular_price_vnd', 'promotional_price_vnd', 'online_voucher_amount_vnd')
      and (data_type <> 'bigint' or is_nullable <> 'YES' or column_default is not null
        or is_generated <> 'NEVER' or is_identity <> 'NO')
  ) then
    raise exception 'HITA_PRICE_PILOT_COLUMN_DEFINITION_CONFLICT';
  end if;
end
$$;

alter table dpg_app.products
  drop constraint if exists products_hita_price_vnd_check,
  add constraint products_hita_price_vnd_check check (
    (regular_price_vnd is null or regular_price_vnd between 1 and 9999999999999)
    and (promotional_price_vnd is null or (
      regular_price_vnd is not null
      and promotional_price_vnd > 0
      and promotional_price_vnd < regular_price_vnd
    ))
    and (online_voucher_amount_vnd is null or (
      regular_price_vnd is not null
      and online_voucher_amount_vnd > 0
      and online_voucher_amount_vnd < coalesce(promotional_price_vnd, regular_price_vnd)
    ))
  ) not valid;

alter table dpg_app.products validate constraint products_hita_price_vnd_check;
commit;
