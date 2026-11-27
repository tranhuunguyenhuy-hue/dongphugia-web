-- DPG-42 REVIEW ARTIFACT — NOT APPLIED. Production (bonxyxluzlxfkdetryoo) only after a separate, exact Owner GO.
-- Purpose: let the existing least-privilege backup login read dpg_commerce so the scheduled encrypted backup covers orders,
-- quotes and events. Run ONCE as the project operator (`postgres`) in one transaction; refuses a wrong target or a
-- non-baseline reader state so the rollback file restores the exact pre-change ACL.
-- Grants ONLY: USAGE on schema dpg_commerce; SELECT on its tables and sequences (SELECT on a sequence reads its state for
-- pg_dump but cannot call nextval/setval); default SELECT for future tables/sequences created by dpg_commerce_owner.
-- No DML, no sequence USAGE/UPDATE, no EXECUTE, no membership, no change to LOGIN/BYPASSRLS/read-only/connection limit.
-- The temporary self-membership in dpg_commerce_owner mirrors the reviewed commerce migration (001_commerce_schema.sql) and
-- is revoked before COMMIT. Rollback: 002_backup_reader_commerce_scope_rollback.sql.
begin;
set local lock_timeout = '5s';
do $$
declare r oid := (select oid from pg_roles where rolname = 'dpg_backup_reader');
begin
  if not exists (select 1 from dpg_control.target_contract where project_name = 'dongphugia-runtime' and production_writes_allowed)
     or (select count(*) from dpg_app.products) < 17000 then raise exception 'DPG42_GUARD: not the Production project'; end if;
  if r is null then raise exception 'DPG42_GUARD: dpg_backup_reader missing'; end if;
  if to_regnamespace('dpg_commerce') is null or pg_get_userbyid((select nspowner from pg_namespace where nspname = 'dpg_commerce')) <> 'dpg_commerce_owner'
    then raise exception 'DPG42_GUARD: dpg_commerce missing or not owned by dpg_commerce_owner'; end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dpg_commerce'
             and c.relkind in ('r','p','v','m','S') and pg_get_userbyid(c.relowner) <> 'dpg_commerce_owner')
    then raise exception 'DPG42_GUARD: a dpg_commerce relation is not owned by dpg_commerce_owner'; end if;
  -- baseline: the reader has no privilege of any kind in dpg_commerce (so the rollback is exact)
  if has_schema_privilege(r, 'dpg_commerce', 'USAGE')
     or exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a
                where n.nspname = 'dpg_commerce' and a.grantee = r)
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace cross join lateral aclexplode(p.proacl) a
                where n.nspname = 'dpg_commerce' and a.grantee = r)
     or exists (select 1 from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a
                where n.nspname = 'dpg_commerce' and a.grantee = r)
    then raise exception 'DPG42_GUARD: dpg_backup_reader already has dpg_commerce privileges (not the reviewed baseline)'; end if;
end $$;

grant dpg_commerce_owner to current_user;
set local role dpg_commerce_owner;
grant usage on schema dpg_commerce to dpg_backup_reader;
grant select on all tables in schema dpg_commerce to dpg_backup_reader;
grant select on all sequences in schema dpg_commerce to dpg_backup_reader;
alter default privileges for role dpg_commerce_owner in schema dpg_commerce grant select on tables to dpg_backup_reader;
alter default privileges for role dpg_commerce_owner in schema dpg_commerce grant select on sequences to dpg_backup_reader;
reset role;
revoke dpg_commerce_owner from current_user;

-- Verification (expect: t | t | relations = readable | 0 | 0 | 0 | 0 | 2): schema usage, read-only default, every relation
-- readable, no table DML, no sequence USAGE/UPDATE, no EXECUTE on any dpg_commerce function, no memberships, 2 default ACL rows.
select has_schema_privilege('dpg_backup_reader', 'dpg_commerce', 'USAGE') as usage,
  exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = 'dpg_backup_reader' and 'default_transaction_read_only=on' = any(s.setconfig)) as read_only,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dpg_commerce' and c.relkind in ('r','p','v','m','S')) as relations,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dpg_commerce' and c.relkind in ('r','p','v','m','S')
     and has_table_privilege('dpg_backup_reader', c.oid, 'SELECT')) as readable,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dpg_commerce' and c.relkind in ('r','p')
     and has_table_privilege('dpg_backup_reader', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) as writable,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dpg_commerce'
     and case when c.relkind = 'S' then has_sequence_privilege('dpg_backup_reader', c.oid, 'USAGE,UPDATE') else false end) as sequence_mutable,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'dpg_commerce'
     and has_function_privilege('dpg_backup_reader', p.oid, 'EXECUTE')) as executable,
  (select count(*) from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'dpg_backup_reader') as memberships,
  (select count(*) from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a
     where n.nspname = 'dpg_commerce' and a.grantee = (select oid from pg_roles where rolname = 'dpg_backup_reader')) as default_acl;
commit;
