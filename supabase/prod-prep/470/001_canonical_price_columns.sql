-- #470 DRAFT — NOT APPLIED. Production additive schema for Hita canonical prices (sanitary scope enforced in code/import, not in DDL).
-- Run as the Production operator `postgres` (BYPASSRLS, inherits dpg_migration which owns the table; dpg_migration itself is NOLOGIN) with:  psql -v ON_ERROR_STOP=1 -v approved_sha=<sha> -f 001_canonical_price_columns.sql
-- Metadata-only on PG 17 (nullable columns without default => no table rewrite). NOT VALID + VALIDATE keeps the lock short.
-- Rollback: 001_canonical_price_columns_rollback.sql
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

select set_config('dpg.price_release_go', :'approved_sha', true);
do $$
begin
  -- guard:begin
  if coalesce(current_setting('dpg.price_release_go', true), '') = '' then
    raise exception 'PRICE_RELEASE_NO_OWNER_GO';
  end if;
  if not exists (
    select 1 from dpg_control.target_contract
    where project_name = 'dongphugia-runtime' and region = 'ap-southeast-1' and environment = 'preview'
      and production_data_allowed = true and production_writes_allowed = true
      and hard_database_ceiling_bytes = 367001600
  ) then
    raise exception 'PRICE_RELEASE_TARGET_NOT_PRODUCTION_CONTRACT';
  end if;
  if pg_database_size(current_database()) > 367001600 - 8 * 1024 * 1024 then
    raise exception 'PRICE_RELEASE_HEADROOM_BELOW_8MIB';
  end if;
  -- guard:end
  if to_regclass('dpg_app.products') is null or not exists (
    select 1 from pg_constraint where conrelid = 'dpg_app.products'::regclass and conname = 'direct_parity_16'
  ) then
    raise exception 'PRICE_RELEASE_PRODUCTS_SHAPE_UNEXPECTED';
  end if;
end
$$;

alter table dpg_app.products
  add column if not exists regular_price_vnd bigint,
  add column if not exists promotional_price_vnd bigint,
  add column if not exists online_voucher_amount_vnd bigint,
  add column if not exists canonical_price_status text,
  add column if not exists canonical_price_checked_at timestamptz;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'dpg_app' and table_name = 'products'
      and ((column_name in ('regular_price_vnd','promotional_price_vnd','online_voucher_amount_vnd') and data_type <> 'bigint')
        or (column_name = 'canonical_price_status' and data_type <> 'text')
        or (column_name = 'canonical_price_checked_at' and data_type <> 'timestamp with time zone'))
      and column_name in ('regular_price_vnd','promotional_price_vnd','online_voucher_amount_vnd','canonical_price_status','canonical_price_checked_at')
  ) or exists (
    select 1 from information_schema.columns
    where table_schema = 'dpg_app' and table_name = 'products'
      and column_name in ('regular_price_vnd','promotional_price_vnd','online_voucher_amount_vnd','canonical_price_status','canonical_price_checked_at')
      and (is_nullable <> 'YES' or column_default is not null or is_generated <> 'NEVER' or is_identity <> 'NO')
  ) then
    raise exception 'PRICE_RELEASE_COLUMN_DEFINITION_CONFLICT';
  end if;
end
$$;

alter table dpg_app.products
  drop constraint if exists products_canonical_price_check,
  add constraint products_canonical_price_check check (
    (canonical_price_status is null or canonical_price_status in
      ('PRICE_VERIFIED','CONTACT_VERIFIED','UNRESOLVED','NOT_FOUND','DISCONTINUED','REVERIFY_REQUIRED'))
    -- prices exist only for a verified price, or for REVERIFY_REQUIRED (Admin re-activated a SKU whose verified price is older than 7 days:
    -- the historical price and its checked-at are KEPT but the status is no longer PRICE_VERIFIED, so Public/orders never use it until it is
    -- verified again). Every other state (and NULL = never crawled) carries no price.
    and (coalesce(canonical_price_status, '') in ('PRICE_VERIFIED','REVERIFY_REQUIRED')
         or (regular_price_vnd is null and promotional_price_vnd is null and online_voucher_amount_vnd is null))
    and (regular_price_vnd is null or regular_price_vnd between 1 and 9999999999999)
    and (promotional_price_vnd is null or (
          regular_price_vnd is not null and promotional_price_vnd > 0 and promotional_price_vnd < regular_price_vnd))
    and (online_voucher_amount_vnd is null or (
          regular_price_vnd is not null and online_voucher_amount_vnd > 0
          and online_voucher_amount_vnd < coalesce(promotional_price_vnd, regular_price_vnd)))
    and (canonical_price_status is distinct from 'PRICE_VERIFIED' or regular_price_vnd is not null)
  ) not valid;

alter table dpg_app.products validate constraint products_canonical_price_check;
commit;
