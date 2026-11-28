select (select count(*) = 1 from dpg_control.target_contract)
  and (select t.environment in ('preview_synthetic', 'ci_synthetic') and t.production_data_allowed is false and t.production_writes_allowed is false and t.hard_database_ceiling_bytes is not null and t.hard_database_ceiling_bytes > 0 from dpg_control.target_contract t limit 1)
  and not exists (select 1 from pg_namespace n where n.nspname like 'dpg\_pilot%')
  and not exists (select 1 from pg_roles r where r.rolname like 'dpg\_pilot%')
  and (select r.rolcreaterole or r.rolsuper from pg_roles r where r.rolname = current_user)
  and has_database_privilege(current_user, current_database(), 'CREATE')
  and pg_database_size(current_database()) + 2 * 1048576 + 15 * 1048576 <= least(350 * 1048576, (select t.hard_database_ceiling_bytes from dpg_control.target_contract t limit 1))
  and not exists (select 1 from pg_default_acl d where d.defaclnamespace = 0 and d.defaclrole = (select r.oid from pg_roles r where r.rolname = current_user))
  and not exists (select 1 from pg_event_trigger e join pg_proc p on p.oid = e.evtfoid join pg_namespace n on n.oid = p.pronamespace where e.evtenabled <> 'D'
    and (n.nspname = 'public' and p.proname = 'rls_auto_enable' and p.pronargs = 0 and p.prorettype = 'event_trigger'::regtype and p.prosecdef and p.proconfig = array['search_path=pg_catalog'] and md5(p.prosrc) = 'c44fb229ea8a6b0afd04a0a33261c16c') is not true) as ok
