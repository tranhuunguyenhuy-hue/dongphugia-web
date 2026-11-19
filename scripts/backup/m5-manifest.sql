-- Schema object, ACL and referenced-role manifest for dpg_app/dpg_control (names and counts only, never row data).
-- Owner self-grants are excluded so a --no-owner restore compares equal. Lines: "object ...", "acl ...", "role ...".
select line from (
  select 'object tables ' || count(*) as line from pg_tables where schemaname in ('dpg_app','dpg_control')
  union all select 'object columns ' || count(*) from information_schema.columns where table_schema in ('dpg_app','dpg_control')
  union all select 'object constraint_' || contype::text || ' ' || count(*) from pg_constraint c join pg_namespace s on s.oid = c.connamespace where s.nspname in ('dpg_app','dpg_control') group by contype
  union all select 'object indexes ' || count(*) from pg_indexes where schemaname in ('dpg_app','dpg_control')
  union all select 'object functions ' || count(*) from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname in ('dpg_app','dpg_control')
  union all select 'object policies ' || count(*) from pg_policies where schemaname in ('dpg_app','dpg_control')
  union all select 'object triggers ' || count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace s on s.oid = c.relnamespace where s.nspname in ('dpg_app','dpg_control') and not t.tgisinternal
  union all select 'object sequences ' || count(*) from pg_sequences where schemaname in ('dpg_app','dpg_control')
  union all select 'object views ' || count(*) from pg_views where schemaname in ('dpg_app','dpg_control')
  union all select 'object rls_enabled ' || count(*) filter (where c.relrowsecurity) || ' forced ' || count(*) filter (where c.relforcerowsecurity) from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname in ('dpg_app','dpg_control') and c.relkind in ('r','p')
  union all select 'acl ' || grantee || ' ' || kind || ' ' || count(*) from (
    select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee, 'table_' || a.privilege_type as kind
      from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a
      where n.nspname in ('dpg_app','dpg_control') and a.grantee <> c.relowner
    union all select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, 'column_' || a.privilege_type
      from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(att.attacl) a
      where n.nspname in ('dpg_app','dpg_control') and att.attacl is not null and a.grantee <> c.relowner
    union all select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, 'function_' || a.privilege_type
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join lateral aclexplode(p.proacl) a
      where n.nspname in ('dpg_app','dpg_control') and a.grantee <> p.proowner
  ) g group by grantee, kind
  union all select distinct 'role ' || r from (
    select pg_get_userbyid(a.grantee) as r from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a where n.nspname in ('dpg_app','dpg_control') and a.grantee <> 0
    union select pg_get_userbyid(a.grantee) from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(att.attacl) a where n.nspname in ('dpg_app','dpg_control') and att.attacl is not null and a.grantee <> 0
    union select pg_get_userbyid(a.grantee) from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join lateral aclexplode(p.proacl) a where n.nspname in ('dpg_app','dpg_control') and a.grantee <> 0
    union select unnest(roles)::text from pg_policies where schemaname in ('dpg_app','dpg_control')
    union select pg_get_userbyid(nspowner) from pg_namespace where nspname in ('dpg_app','dpg_control')
  ) roles where r is not null and r <> 'public'
) manifest order by line
