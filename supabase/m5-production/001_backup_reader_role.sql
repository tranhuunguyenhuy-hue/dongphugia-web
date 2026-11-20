-- M5 PRODUCTION (project bonxyxluzlxfkdetryoo): least-privilege login for the scheduled encrypted backup.
-- Run ONCE in the Supabase SQL Editor as the project owner after replacing the password placeholder with a strong,
-- newly generated password (never reuse, never paste it into chat or GitHub). One transaction; refuses a wrong target.
--
-- Grants: USAGE on dpg_app/dpg_control and SELECT on their tables, views and sequences only (plus default privileges for
-- objects that future migrations create as dpg_migration or postgres). No pg_read_all_data, no other schema, no write
-- privilege. BYPASSRLS is required: 53 tables use FORCE ROW LEVEL SECURITY and pg_dump runs with row_security=off, so a
-- role subject to RLS cannot produce a complete dump (demonstrated in the restore rehearsal, which runs this file against
-- the restored scratch database with and without BYPASSRLS).
-- Residual risk: this role can read every row of these two schemas (customer PII, admin password hashes, session token
-- hashes), as any complete backup must. default_transaction_read_only is defence in depth, NOT access control: the
-- absence of INSERT/UPDATE/DELETE/TRUNCATE grants is what prevents writes (verified by the last query).
begin;
do $$ begin
  if not exists (select 1 from dpg_control.target_contract where project_name = 'dongphugia-runtime' and production_writes_allowed)
     or (select count(*) from dpg_app.products) < 17000 then
    raise exception 'M5_BACKUP_ROLE_GUARD_FAILED: not the Production project';
  end if;
  if exists (select 1 from pg_roles where rolname = 'dpg_backup_reader') then
    raise exception 'M5_BACKUP_ROLE_GUARD_FAILED: dpg_backup_reader already exists';
  end if;
end $$;

create role dpg_backup_reader login bypassrls nosuperuser nocreatedb nocreaterole noreplication noinherit
  connection limit 2 password '<OWNER_GENERATED_STRONG_PASSWORD>';
alter role dpg_backup_reader set default_transaction_read_only = on;
alter role dpg_backup_reader set statement_timeout = '15min';

-- Grant as each object's actual owner (schemas and most objects: dpg_migration; the M4 Admin support tables: postgres).
-- A bulk GRANT as one owner fails with "permission denied" on objects owned by the other, so grant object by object.
do $$
declare o record;
begin
  for o in select n.nspname as schema_name, pg_get_userbyid(n.nspowner) as owner_name
           from pg_namespace n where n.nspname in ('dpg_app', 'dpg_control') loop
    execute format('set local role %I', o.owner_name);
    execute format('grant usage on schema %I to dpg_backup_reader', o.schema_name);
    execute 'reset role';
  end loop;
  for o in select n.nspname as schema_name, c.relname, c.relkind, pg_get_userbyid(c.relowner) as owner_name
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('dpg_app', 'dpg_control') and c.relkind in ('r', 'p', 'v', 'm', 'S') loop
    execute format('set local role %I', o.owner_name);
    execute format('grant select on %s %I.%I to dpg_backup_reader',
                   case when o.relkind = 'S' then 'sequence' else 'table' end, o.schema_name, o.relname);
    execute 'reset role';
  end loop;
end $$;

-- Objects created later by future migrations (as dpg_migration or postgres) become readable automatically.
alter default privileges for role dpg_migration in schema dpg_app, dpg_control grant select on tables to dpg_backup_reader;
alter default privileges for role dpg_migration in schema dpg_app, dpg_control grant select on sequences to dpg_backup_reader;
alter default privileges for role postgres in schema dpg_app, dpg_control grant select on tables to dpg_backup_reader;
alter default privileges for role postgres in schema dpg_app, dpg_control grant select on sequences to dpg_backup_reader;

-- Verification (must show: login, bypassrls, not superuser, conn limit 2, all tables readable, 0 write privileges).
select r.rolname, r.rolcanlogin, r.rolbypassrls, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolconnlimit,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('dpg_app', 'dpg_control') and c.relkind in ('r', 'v', 'm', 'p')) as relations,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('dpg_app', 'dpg_control') and c.relkind in ('r', 'v', 'm', 'p')
       and has_table_privilege('dpg_backup_reader', c.oid, 'SELECT')) as readable,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('dpg_app', 'dpg_control') and c.relkind in ('r', 'p')
       and has_table_privilege('dpg_backup_reader', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')) as writable,
  (select count(*) from pg_auth_members m where m.member = r.oid) as role_memberships
from pg_roles r where r.rolname = 'dpg_backup_reader';
commit;
