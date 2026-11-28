with
fp as (
  select 'schemas' as component, count(*)::int as item_count,
    md5(coalesce(string_agg(n.nspname || ':' || pg_get_userbyid(n.nspowner) || ':' || coalesce(n.nspacl::text, ''), '|' order by n.nspname), '')) as digest
  from pg_namespace n where n.nspname !~ '^(pg_|information_schema$)' and n.nspname <> 'dpg_pilot'
  union all
  select 'relations', count(*)::int,
    md5(coalesce(string_agg(n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || pg_get_userbyid(c.relowner) || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text || ':' || coalesce(c.relacl::text, '') || ':' || coalesce(c.reloptions::text, ''), '|' order by n.nspname, c.relname), ''))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname !~ '^(pg_|information_schema$)' and n.nspname <> 'dpg_pilot' and c.relkind in ('r', 'v', 'm', 'S', 'p', 'f')
  union all
  select 'columns', count(*)::int,
    md5(coalesce(string_agg(n.nspname || '.' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || a.attidentity::text || ':' || a.attgenerated::text || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ':' || coalesce(a.attacl::text, ''), '|' order by n.nspname, c.relname, a.attnum), ''))
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname !~ '^(pg_|information_schema$)' and n.nspname <> 'dpg_pilot' and c.relkind in ('r', 'v', 'm', 'p', 'f') and a.attnum > 0 and not a.attisdropped
  union all
  select 'view_definitions', count(*)::int,
    md5(coalesce(string_agg(n.nspname || '.' || c.relname || ':' || md5(pg_get_viewdef(c.oid)), '|' order by n.nspname, c.relname), ''))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname !~ '^(pg_|information_schema$)' and n.nspname <> 'dpg_pilot' and c.relkind in ('v', 'm')
  union all
  select 'constraints_indexes_triggers', count(*)::int,
    md5(coalesce(string_agg(x.k, '|' order by x.k), ''))
  from (
    select 'con:' || n.nspname || '.' || c.relname || ':' || k.conname || ':' || pg_get_constraintdef(k.oid) as k from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname !~ '^(pg_|information_schema$)' and n.nspname <> 'dpg_pilot'
    union all select 'idx:' || pg_get_indexdef(i.indexrelid) from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname !~ '^(pg_|information_schema$)' and n.nspname <> 'dpg_pilot'
    union all select 'trg:' || t.tgenabled::text || ':' || pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname !~ '^(pg_|information_schema$)' and n.nspname <> 'dpg_pilot'
  ) x
  union all
  select 'routines', count(*)::int,
    md5(coalesce(string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || pg_get_userbyid(p.proowner) || ':' || p.prokind::text || ':' || p.prosecdef::text || ':' || coalesce(p.proacl::text, '') || ':' || coalesce(p.proconfig::text, '') || ':' || md5(coalesce(p.prosrc, '')), '|' order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), ''))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname !~ '^(pg_|information_schema$)' and n.nspname <> 'dpg_pilot'
  union all
  select 'policies', count(*)::int,
    md5(coalesce(string_agg(pol.polrelid::regclass::text || ':' || pol.polname || ':' || pol.polcmd::text || ':' || pol.polpermissive::text || ':' || pol.polroles::text || ':' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ':' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), ''), '|' order by pol.polrelid::regclass::text, pol.polname), ''))
  from pg_policy pol
  union all
  select 'roles', count(*)::int,
    md5(coalesce(string_agg(r.rolname || ':' || r.rolsuper::text || r.rolinherit::text || r.rolcreaterole::text || r.rolcreatedb::text || r.rolcanlogin::text || r.rolreplication::text || r.rolbypassrls::text || ':' || r.rolconnlimit::text || ':' || coalesce(r.rolconfig::text, ''), '|' order by r.rolname), ''))
  from pg_roles r where r.rolname !~ '^dpg_pilot_'
  union all
  select 'memberships', count(*)::int,
    md5(coalesce(string_agg(pg_get_userbyid(m.roleid) || '>' || pg_get_userbyid(m.member) || ':' || m.admin_option::text || ':' || m.inherit_option::text || ':' || m.set_option::text, '|' order by pg_get_userbyid(m.roleid), pg_get_userbyid(m.member)), ''))
  from pg_auth_members m where pg_get_userbyid(m.roleid) !~ '^dpg_pilot_' and pg_get_userbyid(m.member) !~ '^dpg_pilot_'
  union all
  select 'default_acl', count(*)::int,
    md5(coalesce(string_agg(pg_get_userbyid(d.defaclrole) || ':' || d.defaclnamespace::text || ':' || d.defaclobjtype::text || ':' || d.defaclacl::text, '|' order by pg_get_userbyid(d.defaclrole), d.defaclnamespace, d.defaclobjtype), ''))
  from pg_default_acl d
  union all
  select 'extensions_event_triggers', count(*)::int,
    md5(coalesce(string_agg(x.k, '|' order by x.k), ''))
  from (select 'ext:' || e.extname || ':' || e.extversion as k from pg_extension e
        union all select 'evt:' || t.evtname || ':' || t.evtevent || ':' || t.evtenabled::text || ':' || coalesce(t.evttags::text, '') || ':' || t.evtfoid::regproc::text || ':' || md5(coalesce((select p.prosrc from pg_proc p where p.oid = t.evtfoid), '')) from pg_event_trigger t) x
  union all
  select 'database_acl', count(*)::int,
    md5(coalesce(string_agg(coalesce(d.datacl::text, '') || ':' || pg_get_userbyid(d.datdba), '|'), ''))
  from pg_database d where d.datname = current_database()
  union all
  select 'target_contract', count(*)::int,
    md5(coalesce(string_agg(t::text, '|' order by t::text), ''))
  from dpg_control.target_contract t

)
select
  exists (select 1 from pg_namespace n where n.nspname = 'dpg_pilot' and n.nspowner = (select r.oid from pg_roles r where r.rolname = current_user))
  and (select count(*) = 2 from pg_class c where c.relnamespace = to_regnamespace('dpg_pilot') and c.relkind in ('r', 'v', 'm', 'S', 'p', 'f') and c.relname in ('pilot_object', 'pilot_baseline') and c.relowner = (select r.oid from pg_roles r where r.rolname = current_user))
  and (select count(*) = 2 from pg_class c where c.relnamespace = to_regnamespace('dpg_pilot') and c.relkind in ('r', 'v', 'm', 'S', 'p', 'f'))
  and not exists (select 1 from pg_proc p where p.pronamespace = to_regnamespace('dpg_pilot'))
  and (select count(*) = 2 from pg_roles r where r.rolname in ('dpg_pilot_rw', 'dpg_pilot_ro') and not r.rolcanlogin and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole and not r.rolreplication and not r.rolbypassrls and not r.rolinherit and r.rolconfig is null)
  and not exists (select 1 from pg_auth_members m where pg_get_userbyid(m.member) like 'dpg\_pilot\_%')
  and not exists (select 1 from pg_auth_members m where pg_get_userbyid(m.roleid) like 'dpg\_pilot\_%' and m.member <> (select r.oid from pg_roles r where r.rolname = current_user))
  and not exists (select 1 from pg_shdepend s where s.refclassid = 'pg_authid'::regclass and s.deptype = 'o' and s.refobjid in (select r.oid from pg_roles r where r.rolname like 'dpg\_pilot\_%'))
  and (select count(*) = 4 from pg_namespace n, aclexplode(n.nspacl) a where n.nspname = 'dpg_pilot')
  and not exists (select 1 from pg_namespace n, aclexplode(n.nspacl) a where n.nspname = 'dpg_pilot' and (a.is_grantable or a.grantee = 0 or a.grantee not in (select (select r.oid from pg_roles r where r.rolname = current_user) union all select r.oid from pg_roles r where r.rolname like 'dpg\_pilot\_%') or (a.grantee <> (select r.oid from pg_roles r where r.rolname = current_user) and a.privilege_type <> 'USAGE')))
  and (select count(*) = 2 from pg_namespace n, aclexplode(n.nspacl) a where n.nspname = 'dpg_pilot' and a.grantee in (select r.oid from pg_roles r where r.rolname like 'dpg\_pilot\_%') and a.privilege_type = 'USAGE')
  and not exists (select 1 from pg_class c, aclexplode(c.relacl) a where c.relnamespace = to_regnamespace('dpg_pilot') and (a.grantee <> c.relowner or a.is_grantable))
  and not exists (select 1 from pg_class c, aclexplode(c.relacl) a where c.relnamespace <> to_regnamespace('dpg_pilot') and a.grantee in (select r.oid from pg_roles r where r.rolname like 'dpg\_pilot\_%'))
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a where a.grantee in (select r.oid from pg_roles r where r.rolname like 'dpg\_pilot\_%'))
  and not exists (select 1 from pg_namespace n, aclexplode(n.nspacl) a where n.nspname <> 'dpg_pilot' and a.grantee in (select r.oid from pg_roles r where r.rolname like 'dpg\_pilot\_%'))
  and not exists (select 1 from pg_default_acl d, aclexplode(d.defaclacl) a where a.grantee in (select r.oid from pg_roles r where r.rolname like 'dpg\_pilot\_%'))
  and not exists (select 1 from pg_roles r where r.rolname !~ '^(pg_|dpg_pilot_)' and not r.rolsuper and r.oid <> (select r.oid from pg_roles r where r.rolname = current_user)
    and (has_schema_privilege(r.oid, to_regnamespace('dpg_pilot')::oid, 'USAGE,CREATE') or exists (select 1 from pg_class c where c.relnamespace = to_regnamespace('dpg_pilot') and has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))))
  and not exists (select 1 from pg_roles r, pg_class c join pg_namespace n on n.oid = c.relnamespace where r.rolname like 'dpg\_pilot\_%' and c.relkind in ('r', 'v', 'm', 'p', 'f', 'S') and n.nspname !~ '^(pg_|information_schema$)' and n.nspname <> 'dpg_pilot'
    and has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') and (n.nspname like 'dpg\_%' or n.nspname = 'public'))
  and not exists (select 1 from pg_roles r, pg_namespace n where r.rolname like 'dpg\_pilot\_%' and n.nspname like 'dpg\_%' and n.nspname <> 'dpg_pilot' and has_schema_privilege(r.oid, n.oid, 'USAGE,CREATE'))
  and obj_description(to_regnamespace('dpg_pilot'), 'pg_namespace') = 'baseline ' || (select string_agg(f.component || ':' || f.item_count::text || ':' || f.digest, ';' order by f.component) from fp f) as ok
