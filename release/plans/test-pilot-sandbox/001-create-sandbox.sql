-- S2 (TEST only): additive pilot namespace. Creates ONLY pilot-owned objects: schema dpg_pilot (owned by the executing role),
-- two NOLOGIN roles with USAGE on that schema, a registry of what this step created and a baseline fingerprint of everything else.
-- No data, no function, no default privilege, no grant on any pre-existing object, no PUBLIC exposure.
create schema dpg_pilot;
revoke all on schema dpg_pilot from public;
create table dpg_pilot.pilot_object (kind text not null, identity text primary key, note text);
create table dpg_pilot.pilot_baseline (component text primary key, item_count integer not null, digest text not null, captured_at timestamptz not null default now());
revoke all on all tables in schema dpg_pilot from public;
-- baseline of every NON-pilot object (schemas, relations+ACL+RLS flags, routines, policies, roles, memberships, default ACLs, extensions/event triggers, DB ACL, target contract)
insert into dpg_pilot.pilot_baseline (component, item_count, digest)
with
fp as (
  select 'schemas' as component, count(*)::int as item_count,
    md5(coalesce(string_agg(n.nspname || ':' || pg_get_userbyid(n.nspowner) || ':' || coalesce(n.nspacl::text, ''), '|' order by n.nspname), '')) as digest
  from pg_namespace n where n.nspname !~ '^(pg_|information_schema$)' and n.nspname not in ('dpg_pilot', 'dpg_release')
  union all
  select 'relations', count(*)::int,
    md5(coalesce(string_agg(n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || pg_get_userbyid(c.relowner) || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text || ':' || coalesce(c.relacl::text, ''), '|' order by n.nspname, c.relname), ''))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname !~ '^(pg_|information_schema$)' and n.nspname not in ('dpg_pilot', 'dpg_release') and c.relkind in ('r', 'v', 'm', 'S', 'p', 'f')
  union all
  select 'routines', count(*)::int,
    md5(coalesce(string_agg(n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || pg_get_userbyid(p.proowner) || ':' || p.prosecdef::text || ':' || coalesce(p.proacl::text, '') || ':' || coalesce(p.proconfig::text, ''), '|' order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), ''))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname !~ '^(pg_|information_schema$)' and n.nspname not in ('dpg_pilot', 'dpg_release')
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
    md5(coalesce(string_agg(pg_get_userbyid(m.roleid) || '>' || pg_get_userbyid(m.member) || ':' || m.admin_option::text, '|' order by pg_get_userbyid(m.roleid), pg_get_userbyid(m.member)), ''))
  from pg_auth_members m where pg_get_userbyid(m.roleid) !~ '^dpg_pilot_' and pg_get_userbyid(m.member) !~ '^dpg_pilot_'
  union all
  select 'default_acl', count(*)::int,
    md5(coalesce(string_agg(pg_get_userbyid(d.defaclrole) || ':' || d.defaclnamespace::text || ':' || d.defaclobjtype::text || ':' || d.defaclacl::text, '|' order by pg_get_userbyid(d.defaclrole), d.defaclnamespace, d.defaclobjtype), ''))
  from pg_default_acl d
  union all
  select 'extensions_events', count(*)::int,
    md5(coalesce(string_agg(x.k, '|' order by x.k), ''))
  from (select 'ext:' || e.extname || ':' || e.extversion as k from pg_extension e union all select 'evt:' || t.evtname || ':' || t.evtevent from pg_event_trigger t) x
  union all
  select 'database_acl', count(*)::int,
    md5(coalesce(string_agg(coalesce(d.datacl::text, '') || ':' || pg_get_userbyid(d.datdba), '|'), ''))
  from pg_database d where d.datname = current_database()
  union all
  select 'target_contract', count(*)::int,
    md5(coalesce(string_agg(t::text, '|' order by t::text), ''))
  from dpg_control.target_contract t
)
select component, item_count, digest from fp;
do $c$
declare txt text;
begin
  select string_agg(b.component || ':' || b.item_count::text || ':' || b.digest, ';' order by b.component) into txt from dpg_pilot.pilot_baseline b;
  execute format('comment on schema dpg_pilot is %L', 'baseline ' || txt);
end
$c$;
create role dpg_pilot_rw nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
create role dpg_pilot_ro nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
grant usage on schema dpg_pilot to dpg_pilot_rw, dpg_pilot_ro;
insert into dpg_pilot.pilot_object (kind, identity, note) values
  ('schema', 'dpg_pilot', 'owned by the executing role'),
  ('role', 'dpg_pilot_rw', 'NOLOGIN, USAGE on dpg_pilot only'),
  ('role', 'dpg_pilot_ro', 'NOLOGIN, USAGE on dpg_pilot only'),
  ('table', 'dpg_pilot.pilot_object', 'registry'),
  ('table', 'dpg_pilot.pilot_baseline', 'fingerprint of non-pilot catalog at creation');
