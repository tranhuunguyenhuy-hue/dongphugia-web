-- Rolls 004 back. TEST-only; same target guard as 004. Drops only objects created/granted by 004.
do $$ begin
  if not exists (select 1 from dpg_control.target_contract
      where environment='preview_synthetic' and data_class='synthetic-with-approved-public-fixtures'
        and production_data_allowed is false and production_credentials_allowed is false
        and production_writes_allowed is false) then
    raise exception 'M3_TEST_TARGET_GUARD_FAILED:contract';
  end if;
end $$;
do $$
declare spec record;
begin
  for spec in select * from (values
    ('admin_users','select'),('admin_users','update'),('admin_sessions','select'),('admin_sessions','insert'),('admin_sessions','delete'),
    ('admin_api_login_attempts','select'),('admin_api_login_attempts','insert'),('admin_api_login_attempts','delete'),
    ('admin_api_nonces','select'),('admin_api_nonces','insert'),('admin_api_nonces','delete'),('audit_logs','insert'),
    ('products','select'),('products','update'),('categories','select'),('subcategories','select'),('brands','select')
  ) as t(tbl,cmd) loop
    execute format('drop policy if exists %I on dpg_app.%I', 'm3_admin_api_'||spec.cmd, spec.tbl);
  end loop;
end $$;
drop table if exists dpg_app.admin_api_nonces;
drop table if exists dpg_app.admin_api_login_attempts;
do $$ begin
  if exists (select 1 from pg_roles where rolname='dpg_admin_api_test') then
    execute 'reassign owned by dpg_admin_api_test to dpg_migration';
    execute 'drop owned by dpg_admin_api_test';
    execute 'drop role dpg_admin_api_test';
  end if;
end $$;
