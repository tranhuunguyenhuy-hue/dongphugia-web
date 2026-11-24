-- #470 commerce v1 — STAGING TEST ONLY preparation (ref uybumsnyqpwcidjxmfsv, synthetic data). Never run on Production (guard below).
-- The TEST pilot (#446) has regular/promotional/voucher columns but not the status column that commerce v1 and Production 001 use.
-- Additive + idempotent: adds canonical_price_status (+ checked_at) and marks existing synthetic priced rows PRICE_VERIFIED. No row is deleted, no price changes.
begin;
do $$ begin
  if not exists (select 1 from dpg_control.target_contract where project_name = 'dongphugia-phase2-preview-290' and environment = 'preview_synthetic'
      and not production_writes_allowed and not production_data_allowed and not production_credentials_allowed) then raise exception 'COMMERCE_TEST_PREP_NOT_TEST_CONTRACT'; end if;
end $$;
alter table dpg_app.products add column if not exists canonical_price_status text, add column if not exists canonical_price_checked_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'dpg_app.products'::regclass and conname = 'products_canonical_price_status_check') then
    alter table dpg_app.products add constraint products_canonical_price_status_check check (canonical_price_status is null or canonical_price_status in
      ('PRICE_VERIFIED','CONTACT_VERIFIED','UNRESOLVED','NOT_FOUND','DISCONTINUED','REVERIFY_REQUIRED'));
  end if;
end $$;
update dpg_app.products set canonical_price_status = 'PRICE_VERIFIED', canonical_price_checked_at = coalesce(canonical_price_checked_at, now())
 where regular_price_vnd is not null and canonical_price_status is null;
commit;
