-- Reverts only 002: restores the 001 broad grants. Use 001 rollback to remove the roles entirely.
do $$ declare t record; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='dpg_app' and c.relkind='r' loop
    execute format('grant select, insert, update, delete on dpg_app.%I to dpg_admin_m3_test', t.relname);
    execute format('drop policy if exists m3_test_admin_all on dpg_app.%I', t.relname);
    execute format('create policy m3_test_admin_all on dpg_app.%I for all to dpg_admin_m3_test using (true) with check (true)', t.relname);
  end loop;
  execute 'grant usage, select on all sequences in schema dpg_app to dpg_admin_m3_test';
end $$;
