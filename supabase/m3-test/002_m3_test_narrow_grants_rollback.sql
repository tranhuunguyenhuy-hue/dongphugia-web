-- Reverts ONLY 002, restoring the exact 001 baseline (no privilege beyond baseline):
--   admin  = SELECT/INSERT/UPDATE/DELETE on all 68 dpg_app tables, 68 m3_test_admin_all policies, USAGE+SELECT on all dpg_app sequences
--   public = SELECT on the 14 tables of 001 with 14 m3_test_public_select policies, nothing else
-- Same fail-closed guard as forward; operator must also confirm ref uybumsnyqpwcidjxmfsv via the trusted tool first.
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
  if pg_database_size(current_database()) > 200*1024*1024 then
    raise exception 'M3_TEST_TARGET_GUARD_FAILED:size';
  end if;
  if exists (select 1 from dpg_app.orders) or exists (select 1 from dpg_app.customers) then
    raise exception 'M3_TEST_TARGET_GUARD_FAILED:business_data_present';
  end if;
end $$;
do $$
declare t record;
declare base_public text[] := array['products','categories','subcategories','brands','product_images','product_descriptions','product_spec_values','spec_definitions','spec_options','product_documents','product_feature_values','product_features','blog_posts','blog_categories'];
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='dpg_app' and c.relkind='r' loop
    execute format('grant select, insert, update, delete on dpg_app.%I to dpg_admin_m3_test', t.relname);
    execute format('drop policy if exists m3_test_admin_all on dpg_app.%I', t.relname);
    execute format('create policy m3_test_admin_all on dpg_app.%I for all to dpg_admin_m3_test using (true) with check (true)', t.relname);
    execute format('drop policy if exists m3_test_public_select on dpg_app.%I', t.relname);
    if t.relname = any(base_public) then
      execute format('grant select on dpg_app.%I to dpg_public_m3_test', t.relname);
      execute format('create policy m3_test_public_select on dpg_app.%I for select to dpg_public_m3_test using (true)', t.relname);
    else
      execute format('revoke all on dpg_app.%I from dpg_public_m3_test', t.relname);
    end if;
  end loop;
  execute 'grant usage, select on all sequences in schema dpg_app to dpg_admin_m3_test';
  execute 'revoke all on all sequences in schema dpg_app from dpg_public_m3_test';
end $$;
