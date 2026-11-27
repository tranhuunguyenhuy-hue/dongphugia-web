-- DPG-42 REVIEW ARTIFACT — NOT APPLIED. Production (bonxyxluzlxfkdetryoo) only after a separate, exact Owner GO.
-- Lets the existing least-privilege backup login read dpg_commerce so the scheduled encrypted backup covers orders, quotes
-- and events. Run ONCE as the project operator (`postgres`) in ONE transaction; every pre- and post-condition is an
-- assertion that aborts the transaction (nothing is committed unless all hold):
--   psql -X -v ON_ERROR_STOP=1 -v target_ref=bonxyxluzlxfkdetryoo -v approved_sha=<exact reviewed sha> -f 002_backup_reader_commerce_scope.sql
-- Target binding: the database cannot report its own project ref, so the operator must (1) connect with the Owner's Production
-- connection, (2) pass target_ref, which must equal the reviewed literal, and (3) the reviewed Production target contract row
-- must match exactly (same checks as the reviewed commerce migration). Residual: (1) is the operator's responsibility.
-- Grants ONLY: USAGE on schema dpg_commerce; SELECT on its tables and sequences (SELECT on a sequence reads its state for
-- pg_dump but cannot call nextval/setval); default SELECT for future tables/sequences created by dpg_commerce_owner.
-- No DML, column write, CREATE, sequence USAGE/UPDATE, EXECUTE, grant option or membership; LOGIN/BYPASSRLS/read-only/
-- connection limit/statement_timeout unchanged. Every other ACL entry in dpg_commerce and the operator's own memberships
-- are snapshotted and must be identical afterwards. Exact rollback: 002_backup_reader_commerce_scope_rollback.sql.
\set ON_ERROR_STOP on
\if :{?target_ref}
\else
do $$ begin raise exception 'DPG42_GUARD: -v target_ref is required'; end $$;
\endif
\if :{?approved_sha}
\else
do $$ begin raise exception 'DPG42_GUARD: -v approved_sha is required'; end $$;
\endif
begin;
set local lock_timeout = '5s';
select set_config('dpg42.target_ref', :'target_ref', true), set_config('dpg42.approved_sha', :'approved_sha', true);
create temporary table dpg42_baseline on commit drop as
  select * from (
    select 'rel' as k, c.oid::regclass::text as obj, a.grantee, a.grantor, a.privilege_type, a.is_grantable
      from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a where n.nspname = 'dpg_commerce'
    union all select 'col', att.attrelid::regclass::text || '.' || att.attname, a.grantee, a.grantor, a.privilege_type, a.is_grantable
      from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(att.attacl) a
      where n.nspname = 'dpg_commerce' and att.attacl is not null
    union all select 'fn', p.oid::regprocedure::text, a.grantee, a.grantor, a.privilege_type, a.is_grantable
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where n.nspname = 'dpg_commerce'
    union all select 'nsp', n.nspname, a.grantee, a.grantor, a.privilege_type, a.is_grantable
      from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a where n.nspname = 'dpg_commerce'
    union all select 'def:' || pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype::text, n.nspname, a.grantee, a.grantor, a.privilege_type, a.is_grantable
      from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a where n.nspname = 'dpg_commerce'
  ) acl;
create temporary table dpg42_members on commit drop as
  select roleid, member, grantor, admin_option, inherit_option, set_option from pg_auth_members
  where member = (select oid from pg_roles where rolname = current_user) or member = (select oid from pg_roles where rolname = 'dpg_backup_reader');
do $$
declare r oid := (select oid from pg_roles where rolname = 'dpg_backup_reader'); o oid := (select oid from pg_roles where rolname = 'dpg_commerce_owner');
begin
  if current_setting('dpg42.target_ref') <> 'bonxyxluzlxfkdetryoo' or coalesce(current_setting('dpg42.approved_sha'), '') !~ '^[0-9a-f]{40}$' then
    raise exception 'DPG42_GUARD: target_ref/approved_sha not the reviewed values'; end if;
  if not exists (select 1 from dpg_control.target_contract where project_name = 'dongphugia-runtime' and region = 'ap-southeast-1' and environment = 'preview'
                 and hard_database_ceiling_bytes = 367001600 and production_writes_allowed) or (select count(*) from dpg_app.products) < 17000 then
    raise exception 'DPG42_GUARD: not the reviewed Production target contract'; end if;
  if r is null or o is null then raise exception 'DPG42_GUARD: dpg_backup_reader or dpg_commerce_owner missing'; end if;
  -- reader attributes exactly as 001 (no change by this file)
  if not exists (select 1 from pg_roles where oid = r and rolcanlogin and rolbypassrls and not rolsuper and not rolcreaterole and not rolcreatedb
                 and not rolreplication and not rolinherit and rolconnlimit = 2)
     or not exists (select 1 from pg_db_role_setting s where s.setrole = r and s.setdatabase = 0 and 'default_transaction_read_only=on' = any(s.setconfig) and 'statement_timeout=15min' = any(s.setconfig))
    then raise exception 'DPG42_GUARD: dpg_backup_reader attributes differ from 001'; end if;
  if exists (select 1 from pg_auth_members where member = r) then raise exception 'DPG42_GUARD: dpg_backup_reader has role memberships'; end if;
  if exists (select 1 from pg_roles where oid = o and (rolcanlogin or rolsuper or rolbypassrls)) then raise exception 'DPG42_GUARD: dpg_commerce_owner is not a NOLOGIN owner role'; end if;
  -- ownership: the schema and every relation/function in it belong to dpg_commerce_owner
  if (select nspowner from pg_namespace where nspname = 'dpg_commerce') is distinct from o
     or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dpg_commerce' and c.relkind in ('r','p','v','m','S','f') and c.relowner <> o)
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'dpg_commerce' and p.proowner <> o)
    then raise exception 'DPG42_GUARD: dpg_commerce objects not all owned by dpg_commerce_owner'; end if;
  -- the operator may administer dpg_commerce_owner (role creator / ADMIN option)
  if not exists (select 1 from pg_auth_members where roleid = o and member = (select oid from pg_roles where rolname = current_user) and admin_option) then
    raise exception 'DPG42_GUARD: operator has no ADMIN option on dpg_commerce_owner'; end if;
  -- baseline: the reader has no privilege of any kind in dpg_commerce (direct, column, function, schema, default ACL, grant option)
  if exists (select 1 from dpg42_baseline where grantee = r) or has_schema_privilege(r, 'dpg_commerce', 'USAGE,CREATE') then
    raise exception 'DPG42_GUARD: dpg_backup_reader already has dpg_commerce privileges (not the reviewed baseline)'; end if;
end $$;

-- temporary membership only if the operator does not already hold a grant from itself (mirrors 001_commerce_schema.sql)
select not exists (select 1 from pg_auth_members where roleid = 'dpg_commerce_owner'::regrole and member = (select oid from pg_roles where rolname = current_user)
                   and grantor = (select oid from pg_roles where rolname = current_user)) as dpg42_need_grant \gset
\if :dpg42_need_grant
grant dpg_commerce_owner to current_user with inherit false, set true;
\endif
set local role dpg_commerce_owner;
grant usage on schema dpg_commerce to dpg_backup_reader;
grant select on all tables in schema dpg_commerce to dpg_backup_reader;
grant select on all sequences in schema dpg_commerce to dpg_backup_reader;
alter default privileges for role dpg_commerce_owner in schema dpg_commerce grant select on tables to dpg_backup_reader;
alter default privileges for role dpg_commerce_owner in schema dpg_commerce grant select on sequences to dpg_backup_reader;
reset role;
\if :dpg42_need_grant
revoke dpg_commerce_owner from current_user;
\endif

-- post-conditions (abort unless all hold)
do $$
declare r oid := (select oid from pg_roles where rolname = 'dpg_backup_reader'); o oid := (select oid from pg_roles where rolname = 'dpg_commerce_owner');
  rels int; seqs int; bad int;
begin
  select count(*) filter (where relkind <> 'S'), count(*) filter (where relkind = 'S') into rels, seqs
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dpg_commerce' and c.relkind in ('r','p','v','m','S','f');
  -- the reader's new ACL is exactly: schema USAGE; SELECT per relation and per sequence; 2 default-ACL SELECT entries; all granted by the owner, no grant option
  if (select count(*) from pg_namespace n cross join lateral aclexplode(n.nspacl) a where n.nspname = 'dpg_commerce' and a.grantee = r) <> 1
     or not exists (select 1 from pg_namespace n cross join lateral aclexplode(n.nspacl) a where n.nspname = 'dpg_commerce' and a.grantee = r and a.privilege_type = 'USAGE' and a.grantor = o and not a.is_grantable)
    then raise exception 'DPG42_VERIFY: schema ACL for the reader is not exactly USAGE'; end if;
  select count(*) into bad from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a
    where n.nspname = 'dpg_commerce' and a.grantee = r and not (a.privilege_type = 'SELECT' and a.grantor = o and not a.is_grantable);
  if bad <> 0 or (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a
                  where n.nspname = 'dpg_commerce' and a.grantee = r) <> rels + seqs
    then raise exception 'DPG42_VERIFY: relation ACL for the reader is not exactly one SELECT per relation'; end if;
  if exists (select 1 from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(att.attacl) a
             where n.nspname = 'dpg_commerce' and att.attacl is not null and a.grantee = r)
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'dpg_commerce' and has_function_privilege(r, p.oid, 'EXECUTE'))
     or has_schema_privilege(r, 'dpg_commerce', 'CREATE')
    then raise exception 'DPG42_VERIFY: reader has a column, function or CREATE privilege'; end if;
  if (select count(*) from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a
      where n.nspname = 'dpg_commerce' and a.grantee = r and d.defaclrole = o and a.privilege_type = 'SELECT' and not a.is_grantable and d.defaclobjtype in ('r','S')) <> 2
     or exists (select 1 from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a
                where n.nspname = 'dpg_commerce' and a.grantee = r and not (d.defaclrole = o and a.privilege_type = 'SELECT' and d.defaclobjtype in ('r','S')))
    then raise exception 'DPG42_VERIFY: default ACL for the reader is not exactly SELECT on tables and sequences'; end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dpg_commerce'
             and case when c.relkind in ('r','p','v','m','f') then has_table_privilege(r, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                        or has_any_column_privilege(r, c.oid, 'INSERT,UPDATE,REFERENCES') else false end)
     or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dpg_commerce'
             and case when c.relkind = 'S' then has_sequence_privilege(r, c.oid, 'USAGE,UPDATE') else false end)
    then raise exception 'DPG42_VERIFY: reader has an effective write or sequence-mutation path'; end if;
  -- nothing else changed: every non-reader ACL entry in dpg_commerce and the operator's/reader's memberships are identical
  if exists ((select k, obj, grantee, grantor, privilege_type, is_grantable from dpg42_baseline where grantee <> r)
             except all
             (select * from (
               select 'rel', c.oid::regclass::text, a.grantee, a.grantor, a.privilege_type, a.is_grantable from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a where n.nspname = 'dpg_commerce'
               union all select 'col', att.attrelid::regclass::text || '.' || att.attname, a.grantee, a.grantor, a.privilege_type, a.is_grantable from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(att.attacl) a where n.nspname = 'dpg_commerce' and att.attacl is not null
               union all select 'fn', p.oid::regprocedure::text, a.grantee, a.grantor, a.privilege_type, a.is_grantable from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where n.nspname = 'dpg_commerce'
               union all select 'nsp', n.nspname, a.grantee, a.grantor, a.privilege_type, a.is_grantable from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a where n.nspname = 'dpg_commerce'
               union all select 'def:' || pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype::text, n.nspname, a.grantee, a.grantor, a.privilege_type, a.is_grantable from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a where n.nspname = 'dpg_commerce'
             ) now where grantee <> r))
    then raise exception 'DPG42_VERIFY: a non-reader ACL entry changed'; end if;
  if exists (select roleid, member, grantor, admin_option, inherit_option, set_option from dpg42_members
             except select roleid, member, grantor, admin_option, inherit_option, set_option from pg_auth_members
               where member = (select oid from pg_roles where rolname = current_user) or member = r)
     or exists (select roleid, member, grantor, admin_option, inherit_option, set_option from pg_auth_members
               where member = (select oid from pg_roles where rolname = current_user) or member = r
             except select roleid, member, grantor, admin_option, inherit_option, set_option from dpg42_members)
    then raise exception 'DPG42_VERIFY: operator or reader role memberships changed'; end if;
end $$;
select 'DPG42_GRANT_VERIFIED target_ref=' || current_setting('dpg42.target_ref') || ' approved_sha=' || current_setting('dpg42.approved_sha') as result;
commit;
