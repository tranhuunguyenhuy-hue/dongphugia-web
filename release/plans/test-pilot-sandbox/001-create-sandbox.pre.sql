select (select count(*) = 1 from dpg_control.target_contract)
  and (select t.environment in ('preview_synthetic', 'ci_synthetic') and t.production_data_allowed is false and t.production_writes_allowed is false from dpg_control.target_contract t limit 1)
  and not exists (select 1 from pg_namespace n where n.nspname like 'dpg\_pilot%')
  and not exists (select 1 from pg_roles r where r.rolname like 'dpg\_pilot%')
  and (select r.rolcreaterole or r.rolsuper from pg_roles r where r.rolname = current_user)
  and has_database_privilege(current_user, current_database(), 'CREATE')
  and pg_database_size(current_database()) + 2 * 1048576 + 15 * 1048576 <= least(350 * 1048576, (select t.hard_database_ceiling_bytes from dpg_control.target_contract t limit 1)) as ok
