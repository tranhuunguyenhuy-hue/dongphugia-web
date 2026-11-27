-- DPG-42 REVIEW ARTIFACT — NOT APPLIED. Exact rollback of 002_backup_reader_commerce_scope.sql (separate Owner GO).
--   psql -X -v ON_ERROR_STOP=1 -v target_ref=bonxyxluzlxfkdetryoo -v approved_sha=<exact reviewed sha> -f 002_backup_reader_commerce_scope_rollback.sql
-- Fails closed unless the reader's dpg_commerce privileges are EXACTLY what 002 granted (any intervening change needs a
-- manual review, not a blind revoke). Removes only those entries, restoring the reviewed baseline (no reader privilege in
-- dpg_commerce); every other ACL entry and the operator's/reader's memberships must be identical afterwards.
-- Order: revert the scope-v2 workflow first, otherwise the scheduled backup fails closed by design.
\set ON_ERROR_STOP on
\if :{?target_ref}
\else
do $$ begin raise exception 'DPG42_ROLLBACK_GUARD: -v target_ref is required'; end $$;
\endif
\if :{?approved_sha}
\else
do $$ begin raise exception 'DPG42_ROLLBACK_GUARD: -v approved_sha is required'; end $$;
\endif
begin;
set local lock_timeout = '5s';
select set_config('dpg42.target_ref', :'target_ref', true), set_config('dpg42.approved_sha', :'approved_sha', true);
create temporary table dpg42_acl_before on commit drop as
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
declare r oid := (select oid from pg_roles where rolname = 'dpg_backup_reader'); o oid := (select oid from pg_roles where rolname = 'dpg_commerce_owner'); rels int;
begin
  if current_setting('dpg42.target_ref') <> 'bonxyxluzlxfkdetryoo' or coalesce(current_setting('dpg42.approved_sha'), '') !~ '^[0-9a-f]{40}$' then
    raise exception 'DPG42_ROLLBACK_GUARD: target_ref/approved_sha not the reviewed values'; end if;
  if not exists (select 1 from dpg_control.target_contract where project_name = 'dongphugia-runtime' and region = 'ap-southeast-1' and environment = 'preview'
                 and hard_database_ceiling_bytes = 367001600 and production_writes_allowed) then raise exception 'DPG42_ROLLBACK_GUARD: not the reviewed Production target contract'; end if;
  if r is null or o is null then raise exception 'DPG42_ROLLBACK_GUARD: reader or owner role missing'; end if;
  select count(*) into rels from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dpg_commerce' and c.relkind in ('r','p','v','m','S','f');
  -- the reader's entries must be exactly what 002 granted: USAGE + one owner-granted SELECT per relation + 2 default SELECT entries
  if (select count(*) from dpg42_acl_before where grantee = r and k = 'nsp') <> 1
     or not exists (select 1 from dpg42_acl_before where grantee = r and k = 'nsp' and privilege_type = 'USAGE' and grantor = o and not is_grantable)
     or (select count(*) from dpg42_acl_before where grantee = r and k = 'rel') <> rels
     or exists (select 1 from dpg42_acl_before where grantee = r and k = 'rel' and not (privilege_type = 'SELECT' and grantor = o and not is_grantable))
     or exists (select 1 from dpg42_acl_before where grantee = r and k in ('col', 'fn'))
     or (select count(*) from dpg42_acl_before where grantee = r and k like 'def:%') <> 2
     or exists (select 1 from dpg42_acl_before where grantee = r and k like 'def:%' and not (k in ('def:dpg_commerce_owner:r', 'def:dpg_commerce_owner:S') and privilege_type = 'SELECT' and not is_grantable))
    then raise exception 'DPG42_ROLLBACK_GUARD: reader privileges differ from what 002 granted (intervening change: review manually)'; end if;
  if not exists (select 1 from pg_auth_members where roleid = o and member = (select oid from pg_roles where rolname = current_user) and admin_option) then
    raise exception 'DPG42_ROLLBACK_GUARD: operator has no ADMIN option on dpg_commerce_owner'; end if;
end $$;
select not exists (select 1 from pg_auth_members where roleid = 'dpg_commerce_owner'::regrole and member = (select oid from pg_roles where rolname = current_user)
                   and grantor = (select oid from pg_roles where rolname = current_user)) as dpg42_need_grant \gset
\if :dpg42_need_grant
grant dpg_commerce_owner to current_user with inherit false, set true;
\endif
set local role dpg_commerce_owner;
alter default privileges for role dpg_commerce_owner in schema dpg_commerce revoke select on sequences from dpg_backup_reader;
alter default privileges for role dpg_commerce_owner in schema dpg_commerce revoke select on tables from dpg_backup_reader;
revoke select on all sequences in schema dpg_commerce from dpg_backup_reader;
revoke select on all tables in schema dpg_commerce from dpg_backup_reader;
revoke usage on schema dpg_commerce from dpg_backup_reader;
reset role;
\if :dpg42_need_grant
revoke dpg_commerce_owner from current_user;
\endif
do $$
declare r oid := (select oid from pg_roles where rolname = 'dpg_backup_reader');
begin
  if exists (select 1 from pg_namespace n cross join lateral aclexplode(n.nspacl) a where n.nspname = 'dpg_commerce' and a.grantee = r)
     or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a where n.nspname = 'dpg_commerce' and a.grantee = r)
     or exists (select 1 from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a where n.nspname = 'dpg_commerce' and a.grantee = r)
    then raise exception 'DPG42_ROLLBACK_VERIFY: reader still has dpg_commerce privileges'; end if;
  if exists ((select k, obj, grantee, grantor, privilege_type, is_grantable from dpg42_acl_before where grantee <> r)
             except all
             (select * from (
               select 'rel', c.oid::regclass::text, a.grantee, a.grantor, a.privilege_type, a.is_grantable from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a where n.nspname = 'dpg_commerce'
               union all select 'col', att.attrelid::regclass::text || '.' || att.attname, a.grantee, a.grantor, a.privilege_type, a.is_grantable from pg_attribute att join pg_class c on c.oid = att.attrelid join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(att.attacl) a where n.nspname = 'dpg_commerce' and att.attacl is not null
               union all select 'fn', p.oid::regprocedure::text, a.grantee, a.grantor, a.privilege_type, a.is_grantable from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where n.nspname = 'dpg_commerce'
               union all select 'nsp', n.nspname, a.grantee, a.grantor, a.privilege_type, a.is_grantable from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a where n.nspname = 'dpg_commerce'
               union all select 'def:' || pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype::text, n.nspname, a.grantee, a.grantor, a.privilege_type, a.is_grantable from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a where n.nspname = 'dpg_commerce'
             ) now where grantee <> r))
    then raise exception 'DPG42_ROLLBACK_VERIFY: a non-reader ACL entry changed'; end if;
  if exists (select roleid, member, grantor, admin_option, inherit_option, set_option from dpg42_members
             except select roleid, member, grantor, admin_option, inherit_option, set_option from pg_auth_members where member = (select oid from pg_roles where rolname = current_user) or member = r)
     or exists (select roleid, member, grantor, admin_option, inherit_option, set_option from pg_auth_members where member = (select oid from pg_roles where rolname = current_user) or member = r
             except select roleid, member, grantor, admin_option, inherit_option, set_option from dpg42_members)
    then raise exception 'DPG42_ROLLBACK_VERIFY: operator or reader role memberships changed'; end if;
end $$;
select 'DPG42_ROLLBACK_VERIFIED target_ref=' || current_setting('dpg42.target_ref') as result;
commit;
