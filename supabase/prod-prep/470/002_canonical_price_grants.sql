-- #470 DRAFT — NOT APPLIED. Minimum column-level grants for the five new columns. Legacy price columns untouched.
-- Previous ACL of the five columns: none (columns do not exist yet). Table-level readers (dpg_runtime, dpg_readonly,
-- authenticated, dpg_m2_snapshot_read, dpg_backup_reader) need nothing. Rollback: 002_canonical_price_grants_rollback.sql
begin;
set local lock_timeout = '5s';
select set_config('dpg.price_release_go', :'approved_sha', true);
do $$
begin
  if coalesce(current_setting('dpg.price_release_go', true), '') = '' then raise exception 'PRICE_RELEASE_NO_OWNER_GO'; end if;
  if not exists (select 1 from dpg_control.target_contract where environment <> 'preview_synthetic' and hard_database_ceiling_bytes = 367001600) then
    raise exception 'PRICE_RELEASE_TARGET_NOT_PRODUCTION_CONTRACT';
  end if;
  if (select count(*) from pg_attribute where attrelid = 'dpg_app.products'::regclass and not attisdropped
        and attname in ('regular_price_vnd','promotional_price_vnd','online_voucher_amount_vnd','canonical_price_status','canonical_price_checked_at')) <> 5 then
    raise exception 'PRICE_RELEASE_GRANTS_COLUMNS_MISSING';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'dpg_admin_api') or not exists (select 1 from pg_roles where rolname = 'dpg_public_catalogue') then
    raise exception 'PRICE_RELEASE_GRANTS_ROLE_MISSING';
  end if;
end
$$;

-- Admin API: commerce price edit (status is set by the importer or by an explicit admin action, never by the public).
grant select (regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd, canonical_price_status, canonical_price_checked_at) on dpg_app.products to dpg_admin_api;
grant insert (regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd, canonical_price_status, canonical_price_checked_at) on dpg_app.products to dpg_admin_api;
grant update (regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd, canonical_price_status, canonical_price_checked_at) on dpg_app.products to dpg_admin_api;
-- Public catalogue role: read-only on the new columns (it cannot read ANY legacy price column today).
grant select (regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd, canonical_price_status) on dpg_app.products to dpg_public_catalogue;
commit;
