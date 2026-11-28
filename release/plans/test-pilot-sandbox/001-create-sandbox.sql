-- S2 (TEST only): additive pilot namespace. Creates ONLY pilot-owned objects: schema dpg_pilot (owned by the executing role),
-- two NOLOGIN roles with USAGE on that schema, a registry of what this step created and the baseline of everything else.
-- No data, no function, no default privilege, no grant on any pre-existing object, no PUBLIC exposure.
-- 1) fail closed INSIDE this transaction (same session as the DDL): the precheck is re-evaluated atomically; false => division by zero => nothing persists
select 1 / (select case when q.ok then 1 else 0 end from (
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
) q);
-- 2) baseline of every non-pilot object, taken BEFORE the first DDL of this step (transaction-local; the executor's own dpg_release bookkeeping already ran, so it is inside the baseline)
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
select set_config('dpg_pilot.baseline', string_agg(f.component || ':' || f.item_count::text || ':' || f.digest, ';' order by f.component), true) from fp f;
select set_config('dpg_pilot.rowcounts', (select md5(coalesce(string_agg(r.k || '=' || r.c::text, '|' order by r.k), '')) from (select n.nspname || '.' || c.relname as k,
          (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint as c
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and (n.nspname like 'dpg\_%' or n.nspname = 'public') and n.nspname not in ('dpg_pilot', 'dpg_release')) r), true);
create schema dpg_pilot;
revoke all on schema dpg_pilot from public;
create table dpg_pilot.pilot_object (kind text not null, identity text primary key, note text);
create table dpg_pilot.pilot_baseline (component text primary key, item_count integer not null, digest text not null, captured_at timestamptz not null default now());
revoke all on all tables in schema dpg_pilot from public;
insert into dpg_pilot.pilot_baseline (component, item_count, digest)
  select split_part(x, ':', 1), split_part(x, ':', 2)::integer, split_part(x, ':', 3) from unnest(string_to_array(current_setting('dpg_pilot.baseline'), ';')) as x;
do $c$
begin
  execute format('comment on schema dpg_pilot is %L', 'baseline ' || current_setting('dpg_pilot.baseline'));
end
$c$;
create role dpg_pilot_rw nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
create role dpg_pilot_ro nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
grant usage on schema dpg_pilot to dpg_pilot_rw, dpg_pilot_ro;
insert into dpg_pilot.pilot_baseline (component, item_count, digest) values ('row_counts_executor_visible', 0, current_setting('dpg_pilot.rowcounts'));
insert into dpg_pilot.pilot_object (kind, identity, note) values
  ('schema', 'dpg_pilot', 'owned by the executing role'),
  ('role', 'dpg_pilot_rw', 'NOLOGIN, USAGE on dpg_pilot only'),
  ('role', 'dpg_pilot_ro', 'NOLOGIN, USAGE on dpg_pilot only'),
  ('table', 'dpg_pilot.pilot_object', 'registry'),
  ('table', 'dpg_pilot.pilot_baseline', 'baseline of the non-pilot catalog and executor-visible row counts');
-- FINAL-ROWCOUNT-GUARD: same transaction, executor-visible row counts of dpg_*/public tables (executor ledger schema dpg_release excluded) unchanged since before the first DDL
select 1 / (case when (select md5(coalesce(string_agg(r.k || '=' || r.c::text, '|' order by r.k), '')) from (select n.nspname || '.' || c.relname as k,
          (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint as c
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and (n.nspname like 'dpg\_%' or n.nspname = 'public') and n.nspname not in ('dpg_pilot', 'dpg_release')) r) = current_setting('dpg_pilot.rowcounts') then 1 else 0 end);
