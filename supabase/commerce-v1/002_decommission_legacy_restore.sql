-- #470 COMMERCE V1 — exact restore of 002_decommission_legacy.sql (moves the six tables and sequences back, re-creates the twelve functions from the archived definitions
-- with their original owner and ACL). Only on a separate Owner GO. psql -v ON_ERROR_STOP=1 -v approved_sha=<sha> -f 002_decommission_legacy_restore.sql
begin;
set local lock_timeout = '5s';
select set_config('dpg.commerce_go', :'approved_sha', true);
do $$ begin
  if coalesce(current_setting('dpg.commerce_go', true), '') = '' then raise exception 'RESTORE_NO_OWNER_GO'; end if;
  if not exists (select 1 from dpg_control.target_contract where project_name = 'dongphugia-runtime' and region = 'ap-southeast-1' and environment = 'preview' and hard_database_ceiling_bytes = 367001600) then raise exception 'RESTORE_TARGET_NOT_PRODUCTION_CONTRACT'; end if;
  if to_regclass('dpg_legacy_commerce.orders') is null or to_regclass('dpg_legacy_commerce.function_definitions') is null then raise exception 'RESTORE_NOTHING_ARCHIVED'; end if;
  if to_regclass('dpg_app.orders') is not null then raise exception 'RESTORE_TARGET_NOT_EMPTY'; end if;
end $$;
alter table dpg_legacy_commerce.orders set schema dpg_app;
alter table dpg_legacy_commerce.order_items set schema dpg_app;
alter table dpg_legacy_commerce.quote_requests set schema dpg_app;
alter table dpg_legacy_commerce.quote_items set schema dpg_app;
alter table dpg_legacy_commerce.runtime_idempotency_records set schema dpg_app;
alter table dpg_legacy_commerce.runtime_audit_events set schema dpg_app;
do $$ declare s record; begin for s in select c.relname from pg_class c where c.relnamespace = 'dpg_legacy_commerce'::regnamespace and c.relkind = 'S' loop
  execute format('alter sequence dpg_legacy_commerce.%I set schema dpg_app', s.relname); end loop; end $$;
do $$ declare f record; begin
  -- dpg_app helpers first (the RPCs call them)
  for f in select * from dpg_legacy_commerce.function_definitions order by (signature like 'dpg_app.%') desc, signature loop
    execute f.definition;
    execute format('alter function %s owner to %I', f.signature, f.owner);
    execute format('revoke all on function %s from public', f.signature);
    execute format('grant execute on function %s to authenticated', f.signature);
  end loop;
end $$;
drop table dpg_legacy_commerce.function_definitions;
drop schema dpg_legacy_commerce;
commit;
