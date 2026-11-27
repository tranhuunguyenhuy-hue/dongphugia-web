-- DPG-42 (v2): attributes, mutual memberships and role-level settings of the roles recovery needs. No password or secret is read.
-- Required set = (1) every role the backup scope references (owners, grantees, grantors, policy and default-ACL roles),
-- (2) the reviewed runtime roles of scripts/backup/backup-scope.json (psql variable `runtime_roles`, comma list), and (3) the
-- closure of (1)+(2) over memberships in BOTH directions restricted to this project's own `dpg_*` roles - so a login role that is
-- only a MEMBER of a group role (for example the order-intake login in the `dpg_commerce_intake` group, provisioned by
-- scripts/m6/production-sql-apply.mjs) is included even if it is not itself an ACL grantee. Platform roles outside `dpg_*`
-- (postgres, supabase_*, authenticator, ...) are never walked or dumped: they are documented platform prerequisites. Output lines:
-- roleattr / roleexists / member (admin, inherit, set) / rolesetting (global role settings such as statement_timeout) /
-- runtime_role <name> present|absent. The scratch restore re-creates these roles (passwords are NOT recoverable by design: a
-- login role is re-provisioned through the existing approved provisioning, never from a backup) and must reproduce this file
-- exactly (documented exception: `postgres` is the scratch bootstrap superuser, so its attributes/settings are not compared).
-- Scope: psql variable `schemas`.
\if :{?runtime_roles}
\else
\set runtime_roles ''
\endif
with recursive s as (select unnest(string_to_array(:'schemas', ',')) as n),
refs as (
  select c.relowner as r from pg_class c join pg_namespace n on n.oid = c.relnamespace join s on s.n = n.nspname
  union select p.proowner from pg_proc p join pg_namespace n on n.oid = p.pronamespace join s on s.n = n.nspname
  union select n.nspowner from pg_namespace n join s on s.n = n.nspname
  union select x.r from pg_class c join pg_namespace n on n.oid = c.relnamespace join s on s.n = n.nspname cross join lateral aclexplode(c.relacl) a cross join lateral (values (a.grantee), (a.grantor)) x(r)
  union select x.r from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace join s on s.n = n.nspname cross join lateral aclexplode(att.attacl) a cross join lateral (values (a.grantee), (a.grantor)) x(r)
  union select x.r from pg_proc p join pg_namespace n on n.oid = p.pronamespace join s on s.n = n.nspname cross join lateral aclexplode(p.proacl) a cross join lateral (values (a.grantee), (a.grantor)) x(r)
  union select x.r from pg_namespace n join s on s.n = n.nspname cross join lateral aclexplode(n.nspacl) a cross join lateral (values (a.grantee), (a.grantor)) x(r)
  union select x.r from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace join s on s.n = n.nspname cross join lateral aclexplode(d.defaclacl) a cross join lateral (values (d.defaclrole), (a.grantee), (a.grantor)) x(r)
  union select pr.oid from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace join s on s.n = n.nspname cross join lateral unnest(pol.polroles) pr0(oid) join pg_roles pr on pr.oid = pr0.oid
),
seed as (
  select r from refs
  union select oid from pg_roles where rolname = any(string_to_array(:'runtime_roles', ','))
),
closure(r) as (
  select r from seed
  union
  select case when am.roleid = c.r then am.member else am.roleid end
    from closure c
    join pg_roles cr on cr.oid = c.r and cr.rolname like 'dpg\_%'
    join pg_auth_members am on (am.roleid = c.r or am.member = c.r)
    join pg_roles o on o.oid = case when am.roleid = c.r then am.member else am.roleid end and o.rolname like 'dpg\_%'
),
roles as (select r.* from pg_roles r join closure on closure.r = r.oid where r.rolname !~ '^pg_')
select line from (
  select 'roleattr ' || rolname || ' super=' || rolsuper::text || ' inherit=' || rolinherit::text || ' createrole=' || rolcreaterole::text || ' createdb=' || rolcreatedb::text
         || ' login=' || rolcanlogin::text || ' replication=' || rolreplication::text || ' bypassrls=' || rolbypassrls::text || ' connlimit=' || rolconnlimit as line
    from roles where rolname <> 'postgres'
  union all select 'roleexists ' || rolname from roles
  union all select 'member ' || g.rolname || ' ' || m.rolname || ' admin=' || am.admin_option::text || ' inherit=' || am.inherit_option::text || ' set=' || am.set_option::text
    from pg_auth_members am join roles g on g.oid = am.roleid join roles m on m.oid = am.member
  union all select 'rolesetting ' || r.rolname || ' ' || cfg
    from roles r join pg_db_role_setting st on st.setrole = r.oid and st.setdatabase = 0 cross join lateral unnest(st.setconfig) cfg where r.rolname <> 'postgres'
  union all select 'runtime_role ' || n || ' ' || case when exists (select 1 from pg_roles where rolname = n) then 'present' else 'absent' end
    from unnest(string_to_array(:'runtime_roles', ',')) n where n <> ''
) x order by line;
