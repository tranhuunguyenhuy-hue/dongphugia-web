#!/usr/bin/env bash
# DPG-42 (extends the M5 reader proof): on the restored scratch database, re-create dpg_backup_reader exactly as Production
# (001 file) plus the reviewed dpg_commerce grant (002 file, still NOT applied to Production), executed by a NON-superuser
# stand-in for Supabase's postgres, then prove: complete dump of the whole approved scope, no table write, no sequence
# nextval/setval, no EXECUTE of SECURITY DEFINER entry points, no memberships, and BYPASSRLS is still required.
# Env: REPO, optional CONTAINER (default scratch). Requires m4-restore-rehearsal.sh to have restored a v2 bundle into it.
set -euo pipefail
: "${REPO:?}"
c="${CONTAINER:-scratch}"
schemas="$(node "$REPO/scripts/backup/backup-scope.mjs" schemas)"
sqlin() { docker exec -i "$c" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
asreader() { docker exec -i "$c" psql -U dpg_backup_reader -d postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
# the restored ACLs created a stub of dpg_backup_reader (in every restored database): start from a clean slate
for db in $(sqlin -c "select datname from pg_database where not datistemplate and datname <> 'postgres'"); do
  docker exec -i "$c" psql -U postgres -d "$db" -X -q -c "do \$\$ begin if exists (select 1 from pg_roles where rolname = 'dpg_backup_reader') then execute 'drop owned by dpg_backup_reader'; end if; end \$\$"
done
sqlin <<'SQL'
do $$ begin if exists (select 1 from pg_roles where rolname = 'dpg_backup_reader') then
  execute 'drop owned by dpg_backup_reader'; execute 'drop role dpg_backup_reader'; end if; end $$;
create role sb_owner login createrole bypassrls;
grant dpg_migration to sb_owner;
do $$ declare o record; begin
  for o in select nspname from pg_namespace where nspname in ('dpg_app','dpg_control') loop
    execute format('alter schema %I owner to dpg_migration', o.nspname); end loop;
  for o in select n.nspname, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('dpg_app','dpg_control') and c.relkind in ('r','p','v','m')
             and c.relname not in ('admin_api_login_attempts','admin_api_nonces') loop
    execute format('alter %s %I.%I owner to dpg_migration', case when o.relkind = 'v' then 'view' when o.relkind = 'm' then 'materialized view' else 'table' end, o.nspname, o.relname); end loop;
  for o in select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'dpg_app' and c.relname in ('admin_api_login_attempts','admin_api_nonces') loop
    execute format('alter table %I.%I owner to sb_owner', o.nspname, o.relname); end loop;
  for o in select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('dpg_app','dpg_control') and c.relkind = 'S' and pg_get_userbyid(c.relowner) = 'postgres'
             and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a','i')) loop
    execute format('alter sequence %I.%I owner to dpg_migration', o.nspname, o.relname); end loop;
  -- dpg_commerce: everything owned by dpg_commerce_owner (as the reviewed commerce migration creates it); the operator holds
  -- ADMIN on that role (role creator), not SET/INHERIT, exactly like Supabase's postgres after the commerce migration.
  if to_regnamespace('dpg_commerce') is not null then
    execute 'alter schema dpg_commerce owner to dpg_commerce_owner';
    for o in select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'dpg_commerce' and c.relkind in ('r','p','v','m') loop
      execute format('alter table dpg_commerce.%I owner to dpg_commerce_owner', o.relname); end loop;
    for o in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'dpg_commerce' and c.relkind = 'S' and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a','i')) loop
      execute format('alter sequence dpg_commerce.%I owner to dpg_commerce_owner', o.relname); end loop;
    for o in select p.oid::regprocedure as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'dpg_commerce' loop
      execute format('alter function %s owner to dpg_commerce_owner', o.f); end loop;
    execute 'grant dpg_commerce_owner to sb_owner with admin option, inherit false, set false';
  end if;
end $$;
SQL
pw="$(openssl rand -hex 24)"
sed -e "s/<OWNER_GENERATED_STRONG_PASSWORD>/$pw/" -e 's/for role postgres in schema/for role sb_owner in schema/' "$REPO/supabase/m5-production/001_backup_reader_role.sql" \
  | docker exec -i "$c" psql -U sb_owner -d postgres -X -q -A -t -v ON_ERROR_STOP=1 -f - > /tmp/dpg42-reader-verify.txt
IFS='|' read -r name login bypass superuser createrole createdb replication connlimit relations readable writable memberships < /tmp/dpg42-reader-verify.txt
test "$login" = t; test "$bypass" = t; test "$superuser" = f; test "$createrole" = f; test "$createdb" = f; test "$replication" = f
test "$connlimit" = 2; test "$relations" = "$readable"; test "$writable" = 0; test "$memberships" = 0
echo "M5_READER legacy_scope verify=$(tr '\n' ' ' < /tmp/dpg42-reader-verify.txt)"
if [[ ",$schemas," == *",dpg_commerce,"* ]]; then
  docker exec -i "$c" psql -U sb_owner -d postgres -X -q -A -t -v ON_ERROR_STOP=1 -f - < "$REPO/supabase/m5-production/002_backup_reader_commerce_scope.sql" > /tmp/dpg42-commerce-verify.txt
  IFS='|' read -r usage ro crel creadable cwrite cseq cexec cmem cdef < /tmp/dpg42-commerce-verify.txt
  test "$usage" = t; test "$ro" = t; test "$crel" = "$creadable"; test "$crel" -gt 0; test "$cwrite" = 0; test "$cseq" = 0; test "$cexec" = 0; test "$cmem" = 0; test "$cdef" = 2
  echo "M5_READER commerce_scope verify=$(tr '\n' ' ' < /tmp/dpg42-commerce-verify.txt)"
  # the operator is again NOT a member of dpg_commerce_owner (only the pre-existing ADMIN-only grant remains)
  test "$(sqlin -c "select count(*) from pg_auth_members m where m.roleid = 'dpg_commerce_owner'::regrole and m.member = 'sb_owner'::regrole and (m.set_option or m.inherit_option)")" = 0
fi
schema_args=(); IFS=',' read -r -a list <<<"$schemas"; for s in "${list[@]}"; do schema_args+=("--schema=$s"); done
docker exec "$c" pg_dump -U dpg_backup_reader -d postgres --format=custom --no-owner "${schema_args[@]}" -f /tmp/reader.dump
full="$(docker exec "$c" pg_restore -l /tmp/production.dump | grep -vc '^;')"; reader="$(docker exec "$c" pg_restore -l /tmp/reader.dump | grep -vc '^;')"
echo "M5_READER dump=PASS scope=$schemas toc_entries=$reader source_toc_entries=$full"
test "$reader" -gt 0
deny() { if asreader -c "set default_transaction_read_only = off; $1" >/dev/null 2>&1; then echo "M5_READER status=FAIL reason=$2_possible"; exit 1; fi; echo "M5_READER $2=DENIED"; }
deny 'delete from dpg_app.banners where false' write_legacy
if [[ ",$schemas," == *",dpg_commerce,"* ]]; then
  deny 'insert into dpg_commerce.events (entity, entity_id, actor, action) values (''order'', 0, ''x'', ''note'')' write_commerce
  deny 'update dpg_commerce.orders set staff_note = staff_note where false' update_commerce
  deny "select nextval('dpg_commerce.orders_id_seq')" sequence_nextval
  deny "select setval('dpg_commerce.orders_id_seq', 1)" sequence_setval
  deny "select dpg_commerce.order_submit('{}'::jsonb, 'proof-key-1', '0123456789abcdef')" execute_secdef_order_submit
  deny "select dpg_commerce.rate_hit('x', 1, 1)" execute_secdef_rate_hit
  test "$(asreader -c "select count(*) from dpg_commerce.orders")" -ge 0
  echo 'M5_READER commerce_read=ALLOWED'
fi
sqlin -c "alter role dpg_backup_reader nobypassrls"
if docker exec "$c" pg_dump -U dpg_backup_reader -d postgres --format=custom --schema=dpg_app -f /tmp/reader-rls.dump > /tmp/dpg42-rls.log 2>&1; then
  echo 'M5_READER status=FAIL reason=dump_succeeded_without_bypassrls'; exit 1
fi
echo "M5_READER without_bypassrls=FAILS ($(grep -oE 'row-level security|row security' /tmp/dpg42-rls.log | head -1))"
rm -f /tmp/dpg42-reader-verify.txt /tmp/dpg42-commerce-verify.txt /tmp/dpg42-rls.log
echo 'M5_READER status=PASS'
