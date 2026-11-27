-- DPG-42 REVIEW ARTIFACT — NOT APPLIED. Exact rollback of 002_backup_reader_commerce_scope.sql (separate Owner GO).
-- Removes ONLY what 002 granted to dpg_backup_reader in dpg_commerce; the reviewed baseline was "no privilege", so this
-- restores it exactly. Touches no other role, schema or privilege. After rollback the backup must again exclude dpg_commerce
-- (revert the workflow scope first, otherwise the scheduled backup fails closed by design).
begin;
set local lock_timeout = '5s';
do $$ begin
  if not exists (select 1 from dpg_control.target_contract where project_name = 'dongphugia-runtime' and production_writes_allowed)
    then raise exception 'DPG42_ROLLBACK_GUARD: not the Production project'; end if;
  if not exists (select 1 from pg_roles where rolname = 'dpg_backup_reader') then raise exception 'DPG42_ROLLBACK_GUARD: reader missing'; end if;
end $$;
grant dpg_commerce_owner to current_user;
set local role dpg_commerce_owner;
alter default privileges for role dpg_commerce_owner in schema dpg_commerce revoke select on sequences from dpg_backup_reader;
alter default privileges for role dpg_commerce_owner in schema dpg_commerce revoke select on tables from dpg_backup_reader;
revoke select on all sequences in schema dpg_commerce from dpg_backup_reader;
revoke select on all tables in schema dpg_commerce from dpg_backup_reader;
revoke usage on schema dpg_commerce from dpg_backup_reader;
reset role;
revoke dpg_commerce_owner from current_user;
-- Verification (expect all false/0): no privilege of any kind for the reader in dpg_commerce.
select has_schema_privilege('dpg_backup_reader', 'dpg_commerce', 'USAGE') as usage,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a
     where n.nspname = 'dpg_commerce' and a.grantee = (select oid from pg_roles where rolname = 'dpg_backup_reader')) as relation_acl,
  (select count(*) from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a
     where n.nspname = 'dpg_commerce' and a.grantee = (select oid from pg_roles where rolname = 'dpg_backup_reader')) as default_acl;
commit;
