-- M3 TEST-only (project uybumsnyqpwcidjxmfsv). Records the reviewed connection capacity of the two M3 login
-- roles. Already applied live on 2026-11-17 after the 10-connection limit from 001 was exhausted by the
-- Preview Workers (each Worker isolate opens its own Hyperdrive-pooled connection per request). Idempotent.
-- Capacity budget on the Supabase Free TEST project (max_connections=60): admin 25 + public 25 = 50 role
-- ceiling; the effective origin concurrency is further bounded by Hyperdrive origin_connection_limit=12 per
-- configuration (see docs/deploy/m3-fixed-preview-runbook.md, "TEST capacity provenance").
-- Verify, immediately before apply, that the runner targets exactly ref uybumsnyqpwcidjxmfsv.
do $$ begin
  if not exists (select 1 from dpg_control.target_contract
      where environment='preview_synthetic' and data_class='synthetic-with-approved-public-fixtures'
        and production_data_allowed is false and production_credentials_allowed is false
        and production_writes_allowed is false) then
    raise exception 'M3_TEST_TARGET_GUARD_FAILED:contract';
  end if;
  if (select count(*) from pg_roles where rolname in ('dpg_admin_m3_test','dpg_public_m3_test')) <> 2 then
    raise exception 'M3_TEST_TARGET_GUARD_FAILED:roles';
  end if;
  if current_setting('max_connections')::int < 50 then
    raise exception 'M3_TEST_TARGET_GUARD_FAILED:max_connections';
  end if;
end $$;
alter role dpg_admin_m3_test connection limit 25;
alter role dpg_public_m3_test connection limit 25;
