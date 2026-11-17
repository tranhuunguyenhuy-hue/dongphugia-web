-- Removes only the objects created by 001_m3_test_roles.sql.
do $$ declare t record; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='dpg_app' and c.relkind='r' loop
    execute format('drop policy if exists m3_test_admin_all on dpg_app.%I', t.relname);
    execute format('drop policy if exists m3_test_public_select on dpg_app.%I', t.relname);
  end loop;
end $$;
drop owned by dpg_admin_m3_test;
drop owned by dpg_public_m3_test;
drop role dpg_admin_m3_test;
drop role dpg_public_m3_test;
