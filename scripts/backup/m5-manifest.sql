-- Schema object, ACL and referenced-role manifest for the backup scope (names, counts and definition hashes only, never row data).
-- Scope: psql variable `schemas` (comma separated, from scripts/backup/backup-scope.mjs). Unset = historical v1 scope
-- dpg_app,dpg_control so existing callers (scripts/m5-cdn/rehearse.sh, v1 bundles) produce byte-identical output.
-- Line kinds: object/acl/role (v1) + defs/seq/schemaacl/defacl (v2, DPG-42). The restore gate compares only the kinds the
-- source bundle recorded, and requires the v2 kinds for a v2 bundle.
-- Owner self-grants are excluded so a --no-owner restore compares equal. Lines: "object ...", "acl ...", "role ...".
\if :{?schemas}
\else
\set schemas dpg_app,dpg_control
\endif
\if :{?manifest_version}
\else
\set manifest_version 1
\endif
select line from (
  select 'object tables ' || count(*) as line from pg_tables where schemaname = any(string_to_array(:'schemas', ','))
  union all select 'object columns ' || count(*) from information_schema.columns where table_schema = any(string_to_array(:'schemas', ','))
  union all select 'object constraint_' || contype::text || ' ' || count(*) from pg_constraint c join pg_namespace s on s.oid = c.connamespace where s.nspname = any(string_to_array(:'schemas', ',')) group by contype
  union all select 'object indexes ' || count(*) from pg_indexes where schemaname = any(string_to_array(:'schemas', ','))
  union all select 'object functions ' || count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = any(string_to_array(:'schemas', ','))
  union all select 'object policies ' || count(*) from pg_policies where schemaname = any(string_to_array(:'schemas', ','))
  union all select 'object triggers ' || count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace s on s.oid = c.relnamespace where s.nspname = any(string_to_array(:'schemas', ',')) and not t.tgisinternal
  union all select 'object sequences ' || count(*) from pg_sequences where schemaname = any(string_to_array(:'schemas', ','))
  union all select 'object views ' || count(*) from pg_views where schemaname = any(string_to_array(:'schemas', ','))
  union all select 'object rls_enabled ' || count(*) filter (where c.relrowsecurity) || ' forced ' || count(*) filter (where c.relforcerowsecurity) from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = any(string_to_array(:'schemas', ',')) and c.relkind in ('r','p')
  union all select 'defs ' || k || ' ' || sch || ' ' || md5(string_agg(d, E'\n' order by d)) from (
    select 'constraints' as k, s.nspname as sch, c.conrelid::regclass::text || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid) as d
      from pg_constraint c join pg_namespace s on s.oid = c.connamespace where s.nspname = any(string_to_array(:'schemas', ','))
    union all select 'indexes', schemaname, indexdef from pg_indexes where schemaname = any(string_to_array(:'schemas', ','))
    union all select 'policies', schemaname, tablename || ' ' || policyname || ' ' || permissive || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '')
      from pg_policies where schemaname = any(string_to_array(:'schemas', ','))
    union all select 'functions', n.nspname, pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any(string_to_array(:'schemas', ',')) and p.prokind in ('f', 'p')
    union all select 'triggers', n.nspname, c.relname || ' ' || pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any(string_to_array(:'schemas', ',')) and not t.tgisinternal
  ) defs where :'manifest_version' = '2' group by k, sch
  -- sequences are non-transactional, so their value cannot be read inside the snapshot: compare existence here and let the
  -- restore prove sequence SAFETY instead (every owned sequence >= max of its column, see m4-restore-rehearsal.sh).
  union all select 'seq ' || schemaname || '.' || sequencename
    from pg_sequences where schemaname = any(string_to_array(:'schemas', ',')) and :'manifest_version' = '2'
  union all select 'schemaacl ' || n.nspname || ' ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ' ' || a.privilege_type
    from pg_namespace n cross join lateral aclexplode(n.nspacl) a where n.nspname = any(string_to_array(:'schemas', ',')) and a.grantee <> n.nspowner and :'manifest_version' = '2'
  union all select 'defacl ' || coalesce(n.nspname, '*') || ' ' || pg_get_userbyid(d.defaclrole) || ' ' || d.defaclobjtype::text || ' ' || array_to_string(array(select x::text from unnest(d.defaclacl) x order by 1), ',')
    from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace where (n.nspname = any(string_to_array(:'schemas', ','))) and :'manifest_version' = '2'
  union all select 'acl ' || grantee || ' ' || kind || ' ' || count(*) from (
    select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee, 'table_' || a.privilege_type as kind
      from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a
      where n.nspname = any(string_to_array(:'schemas', ',')) and a.grantee <> c.relowner
    union all select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, 'column_' || a.privilege_type
      from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(att.attacl) a
      where n.nspname = any(string_to_array(:'schemas', ',')) and att.attacl is not null and a.grantee <> c.relowner
    union all select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, 'function_' || a.privilege_type
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join lateral aclexplode(p.proacl) a
      where n.nspname = any(string_to_array(:'schemas', ',')) and a.grantee <> p.proowner
  ) g group by grantee, kind
  union all select distinct 'role ' || r from (
    select pg_get_userbyid(a.grantee) as r from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a where n.nspname = any(string_to_array(:'schemas', ',')) and a.grantee <> 0
    union select pg_get_userbyid(a.grantee) from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(att.attacl) a where n.nspname = any(string_to_array(:'schemas', ',')) and att.attacl is not null and a.grantee <> 0
    union select pg_get_userbyid(a.grantee) from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join lateral aclexplode(p.proacl) a where n.nspname = any(string_to_array(:'schemas', ',')) and a.grantee <> 0
    union select unnest(roles)::text from pg_policies where schemaname = any(string_to_array(:'schemas', ','))
    union select pg_get_userbyid(nspowner) from pg_namespace where nspname = any(string_to_array(:'schemas', ','))
  ) roles where r is not null and r <> 'public'
) manifest order by line
