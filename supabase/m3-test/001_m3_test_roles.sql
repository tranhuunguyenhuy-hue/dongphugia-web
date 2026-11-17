-- M3 TEST-only (project uybumsnyqpwcidjxmfsv). Additive: two least-privilege login roles
-- on the existing synthetic dpg_app schema. No data/schema change, no BYPASSRLS, no DDL.
-- Passwords are substituted at apply time and never committed. Rollback: 001_m3_test_roles_rollback.sql
do $$ begin
  if current_setting('server_version_num')::int < 150000 then raise exception 'unexpected server'; end if;
  if not exists (select 1 from dpg_control.target_contract) then raise exception 'not the TEST target'; end if;
end $$;
create role dpg_admin_m3_test login password '__ADMIN_PW__' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 10;
create role dpg_public_m3_test login password '__PUBLIC_PW__' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 10;
alter role dpg_admin_m3_test set statement_timeout='15s';
alter role dpg_public_m3_test set statement_timeout='5s';
alter role dpg_public_m3_test set default_transaction_read_only=on;
grant usage on schema dpg_app to dpg_admin_m3_test, dpg_public_m3_test;
do $$
declare t record;
declare pub text[] := array['products','categories','subcategories','brands','product_images','product_descriptions','product_spec_values','spec_definitions','spec_options','product_documents','product_feature_values','product_features','blog_posts','blog_categories'];
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='dpg_app' and c.relkind='r' loop
    execute format('grant select, insert, update, delete on dpg_app.%I to dpg_admin_m3_test', t.relname);
    execute format('create policy m3_test_admin_all on dpg_app.%I for all to dpg_admin_m3_test using (true) with check (true)', t.relname);
    if t.relname = any(pub) then
      execute format('grant select on dpg_app.%I to dpg_public_m3_test', t.relname);
      execute format('create policy m3_test_public_select on dpg_app.%I for select to dpg_public_m3_test using (true)', t.relname);
    end if;
  end loop;
  execute 'grant usage, select on all sequences in schema dpg_app to dpg_admin_m3_test';
end $$;
