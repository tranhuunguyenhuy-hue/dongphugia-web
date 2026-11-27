-- DPG-42 (v2): attributes and mutual memberships of every role the backup scope references (owners, grantees, grantors,
-- policy and default-ACL roles). No password or secret is read. The scratch restore re-creates these roles with the same
-- attributes and memberships and must reproduce this file exactly (documented exception: `postgres` is the scratch
-- bootstrap superuser, so its attributes are not compared). Scope: psql variable `schemas`.
with s as (select unnest(string_to_array(:'schemas', ',')) as n),
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
roles as (select r.* from pg_roles r join refs on refs.r = r.oid where r.rolname !~ '^pg_')
select line from (
  select 'roleattr ' || rolname || ' super=' || rolsuper::text || ' inherit=' || rolinherit::text || ' createrole=' || rolcreaterole::text || ' createdb=' || rolcreatedb::text
         || ' login=' || rolcanlogin::text || ' replication=' || rolreplication::text || ' bypassrls=' || rolbypassrls::text || ' connlimit=' || rolconnlimit as line
    from roles where rolname <> 'postgres'
  union all select 'roleexists ' || rolname from roles
  union all select 'member ' || g.rolname || ' ' || m.rolname || ' admin=' || am.admin_option::text || ' inherit=' || am.inherit_option::text || ' set=' || am.set_option::text
    from pg_auth_members am join roles g on g.oid = am.roleid join roles m on m.oid = am.member
) x order by line;
