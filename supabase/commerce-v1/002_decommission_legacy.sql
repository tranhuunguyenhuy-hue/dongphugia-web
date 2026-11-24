-- #470 COMMERCE V1 — DECOMMISSION of the legacy order/quote system. DRAFT, NOT APPLIED. Owner GO + backup required (see release manifest §13).
-- Legacy = dpg_app.orders / order_items / quote_requests / quote_items / runtime_idempotency_records / runtime_audit_events, public.runtime_order_* / runtime_quote_* (10 RPCs),
-- dpg_app.runtime_hash / runtime_key_hash. Production (read-only 24/11): 0 orders, 0 quotes, 0 auth.users. Nothing is DROPPED or DELETED here:
--   * the six tables are MOVED (data, indexes, constraints, RLS, grants intact) into the archive schema `dpg_legacy_commerce`, which nobody but the owner can use;
--   * the twelve functions are dropped AFTER their exact definitions + ACL are stored in dpg_legacy_commerce.function_definitions, so 002_..._restore.sql rebuilds them byte-for-byte.
-- Rollback is exact and tested: 002_decommission_legacy_restore.sql. Worker rollback never re-opens the legacy path (nothing in the Worker/Admin reads these objects any more).
-- psql -v ON_ERROR_STOP=1 -v approved_sha=<sha> -v backup_ref=<sha256-or-id-of-the-verified-backup> -f 002_decommission_legacy.sql   (operator: postgres)
begin;
set local lock_timeout = '5s';
select set_config('dpg.commerce_go', :'approved_sha', true), set_config('dpg.commerce_backup', :'backup_ref', true);
do $$
begin
  if coalesce(current_setting('dpg.commerce_go', true), '') = '' then raise exception 'DECOMMISSION_NO_OWNER_GO'; end if;
  if coalesce(current_setting('dpg.commerce_backup', true), '') !~ '^[A-Za-z0-9._:-]{8,128}$' then raise exception 'DECOMMISSION_NO_BACKUP_REFERENCE'; end if;
  if not exists (select 1 from dpg_control.target_contract where project_name = 'dongphugia-runtime' and region = 'ap-southeast-1' and environment = 'preview' and hard_database_ceiling_bytes = 367001600) then
    raise exception 'DECOMMISSION_TARGET_NOT_PRODUCTION_CONTRACT'; end if;
  if to_regnamespace('dpg_commerce') is null then raise exception 'DECOMMISSION_REQUIRES_COMMERCE_V1_FIRST'; end if;   -- the replacement must exist before the old system goes away
  if to_regnamespace('dpg_legacy_commerce') is not null then raise exception 'DECOMMISSION_ALREADY_ARCHIVED'; end if;
end $$;

create schema dpg_legacy_commerce;
revoke all on schema dpg_legacy_commerce from public;
create table dpg_legacy_commerce.function_definitions (signature text primary key, definition text not null, acl text, owner text not null, archived_at timestamptz not null default now(), backup_ref text not null);
insert into dpg_legacy_commerce.function_definitions (signature, definition, acl, owner, backup_ref)
  select p.oid::regprocedure::text, pg_get_functiondef(p.oid), p.proacl::text, pg_get_userbyid(p.proowner), current_setting('dpg.commerce_backup')
    from pg_proc p where (p.pronamespace = 'public'::regnamespace and p.proname ~ '^runtime_(order|quote)_(create|get|list|update|delete)$')
                      or (p.pronamespace = 'dpg_app'::regnamespace and p.proname in ('runtime_hash', 'runtime_key_hash'));
do $$ begin if (select count(*) from dpg_legacy_commerce.function_definitions) <> 12 then raise exception 'DECOMMISSION_FUNCTION_SET_UNEXPECTED'; end if; end $$;
do $$ declare s text; begin for s in select signature from dpg_legacy_commerce.function_definitions loop execute 'drop function ' || s; end loop; end $$;
alter table dpg_app.orders set schema dpg_legacy_commerce;
alter table dpg_app.order_items set schema dpg_legacy_commerce;
alter table dpg_app.quote_requests set schema dpg_legacy_commerce;
alter table dpg_app.quote_items set schema dpg_legacy_commerce;
alter table dpg_app.runtime_idempotency_records set schema dpg_legacy_commerce;
alter table dpg_app.runtime_audit_events set schema dpg_legacy_commerce;
do $$ declare s record; begin for s in select c.relname from pg_class c where c.relnamespace = 'dpg_app'::regnamespace and c.relkind = 'S' and c.relname in ('orders_id_seq', 'order_items_id_seq', 'quote_requests_id_seq', 'quote_items_id_seq', 'runtime_audit_events_id_seq') loop
  execute format('alter sequence dpg_app.%I set schema dpg_legacy_commerce', s.relname); end loop; end $$;
-- post-condition: the old objects are unreachable from every API role, the data is intact in the archive
do $$ declare v_bad text; begin
  select string_agg(distinct r, ', ') into v_bad from (values ('authenticated'), ('anon'), ('service_role'), ('dpg_runtime'), ('dpg_readonly'), ('dpg_public_catalogue')) roles(r)
    where exists (select 1 from pg_roles where rolname = r) and has_schema_privilege(r, 'dpg_legacy_commerce', 'usage');
  if v_bad is not null then raise exception 'DECOMMISSION_ARCHIVE_REACHABLE %', v_bad; end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname ~ '^runtime_(order|quote)_') then raise exception 'DECOMMISSION_FUNCTION_LEFT_BEHIND'; end if;
  if to_regclass('dpg_app.orders') is not null or to_regclass('dpg_app.quote_requests') is not null then raise exception 'DECOMMISSION_TABLE_LEFT_BEHIND'; end if;
end $$;
commit;
