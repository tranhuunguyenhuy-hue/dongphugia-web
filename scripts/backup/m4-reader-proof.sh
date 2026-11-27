#!/usr/bin/env bash
# DPG-42 (extends the M5 reader proof) on the ownership-preserving restored scratch database `restored` (v2): re-create
# dpg_backup_reader exactly as Production (001 file) plus the reviewed dpg_commerce grant (002 file, still NOT applied to
# Production), both executed by a NON-superuser stand-in for Supabase's postgres, then prove: (a) the reader's dump has
# exactly the same table-data/sequence-state inventory as the full archive; (b) every write, column write, CREATE,
# nextval/setval, SECURITY DEFINER EXECUTE and SET ROLE attempt is refused with SQLSTATE 42501 (insufficient_privilege)
# while the read-only default is explicitly switched off, so a syntax error or read-only refusal can never count as DENIED;
# (c) BYPASSRLS is still required. Env: REPO, optional CONTAINER (default scratch), optional DB (default restored).
set -euo pipefail
: "${REPO:?}"
c="${CONTAINER:-scratch}"; db="${DB:-restored}"
schemas="$(node "$REPO/scripts/backup/backup-scope.mjs" schemas)"
sqlin() { docker exec -i "$c" psql -U postgres -d "$db" -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
fail() { echo "M5_READER status=FAIL reason=$1"; exit 1; }
# The restored ACLs reference dpg_backup_reader (re-created from roles.txt): start from a clean slate in every database.
for d in $(docker exec -i "$c" psql -U postgres -X -q -A -t -c "select datname from pg_database where not datistemplate"); do
  docker exec -i "$c" psql -U postgres -d "$d" -X -q -c "do \$\$ begin if exists (select 1 from pg_roles where rolname = 'dpg_backup_reader') then execute 'drop owned by dpg_backup_reader'; end if; end \$\$" >/dev/null
done
sqlin <<'SQL' >/dev/null
do $$ begin if exists (select 1 from pg_roles where rolname = 'dpg_backup_reader') then execute 'drop role dpg_backup_reader'; end if; end $$;
create role sb_owner login createrole bypassrls;
grant dpg_migration to sb_owner;
-- Production's postgres owns the M4 Admin support tables; the stand-in owns them here (postgres is the scratch superuser).
do $$ declare o record; begin
  for o in select n.nspname, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('dpg_app','dpg_control') and c.relkind in ('r','p','v','m') and pg_get_userbyid(c.relowner) = 'postgres' loop
    execute format('alter %s %I.%I owner to sb_owner', case when o.relkind = 'v' then 'view' when o.relkind = 'm' then 'materialized view' else 'table' end, o.nspname, o.relname); end loop;
  for o in select n.nspname, c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('dpg_app','dpg_control') and c.relkind = 'S' and pg_get_userbyid(c.relowner) = 'postgres'
             and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a','i')) loop
    execute format('alter sequence %I.%I owner to sb_owner', o.nspname, o.relname); end loop;
  if exists (select 1 from pg_namespace where nspname in ('dpg_app','dpg_control') and pg_get_userbyid(nspowner) = 'postgres') then
    raise exception 'DPG42_PROOF: legacy schema owned by postgres (not the reviewed ownership)'; end if;
end $$;
-- like Supabase's postgres after the reviewed commerce migration: ADMIN on dpg_commerce_owner only (no SET/INHERIT)
grant dpg_commerce_owner to sb_owner with admin true, inherit false, set false;
SQL
pw="$(openssl rand -hex 24)"
sed -e "s/<OWNER_GENERATED_STRONG_PASSWORD>/$pw/" -e 's/for role postgres in schema/for role sb_owner in schema/' "$REPO/supabase/m5-production/001_backup_reader_role.sql" \
  | docker exec -i "$c" psql -U sb_owner -d "$db" -X -q -A -t -v ON_ERROR_STOP=1 -f - > /tmp/dpg42-reader-verify.txt || fail apply_001
IFS='|' read -r name login bypass superuser createrole createdb replication connlimit relations readable writable memberships < /tmp/dpg42-reader-verify.txt
[ "$login|$bypass|$superuser|$createrole|$createdb|$replication|$connlimit|$writable|$memberships" = 't|t|f|f|f|f|2|0|0' ] && [ "$relations" = "$readable" ] || fail verify_001
echo "M5_READER legacy_scope verify=$(tr '\n' ' ' < /tmp/dpg42-reader-verify.txt)"
if [[ ",$schemas," == *",dpg_commerce,"* ]]; then
  docker exec -i "$c" psql -U sb_owner -d "$db" -X -q -A -t -v ON_ERROR_STOP=1 -v target_ref=bonxyxluzlxfkdetryoo -v approved_sha="$(printf 'f%.0s' $(seq 1 40))" \
    -f - < "$REPO/supabase/m5-production/002_backup_reader_commerce_scope.sql" > /tmp/dpg42-commerce-verify.txt 2>/dev/null || fail apply_002
  grep -q '^DPG42_GRANT_VERIFIED ' /tmp/dpg42-commerce-verify.txt || fail verify_002
  echo "M5_READER commerce_scope $(grep '^DPG42_GRANT_VERIFIED' /tmp/dpg42-commerce-verify.txt | cut -d' ' -f1)"
  [ "$(sqlin -c "select count(*) from pg_auth_members m where m.roleid = 'dpg_commerce_owner'::regrole and m.member = 'sb_owner'::regrole and (m.set_option or m.inherit_option)")" = 0 ] || fail operator_membership_changed
fi
schema_args=(); IFS=',' read -r -a list <<<"$schemas"; for s in "${list[@]}"; do schema_args+=("--schema=$s"); done
docker exec "$c" pg_dump -U dpg_backup_reader -d "$db" --format=custom --no-owner "${schema_args[@]}" -f /tmp/reader.dump 2>/dev/null || fail reader_dump
inv() { docker exec "$c" pg_restore -l "$1" | sed -nE 's/^[0-9]+; [0-9]+ [0-9]+ (TABLE DATA|SEQUENCE SET) ([^ ]+) ([^ ]+) .*/\1 \2.\3/p' | sort; }
inv /tmp/production.dump > /tmp/dpg42-full.inv; inv /tmp/reader.dump > /tmp/dpg42-reader.inv
[ -s /tmp/dpg42-full.inv ] && cmp -s /tmp/dpg42-full.inv /tmp/dpg42-reader.inv || fail reader_dump_inventory_differs
echo "M5_READER dump=PASS scope=$schemas table_data_and_sequence_entries=$(wc -l < /tmp/dpg42-reader.inv) identical_to_full_archive=true"
# Denials: SQLSTATE must be 42501 with the read-only default explicitly OFF (25006 read-only or 42601 syntax never count).
deny() {
  local label="$1" stmt="$2" out
  out="$(docker exec -i "$c" psql -U dpg_backup_reader -d "$db" -X -q -A -t <<SQL 2>/dev/null
set default_transaction_read_only = off;
select current_setting('transaction_read_only') as ro \gset
\echo RO=:ro
$stmt
\echo STATE=:SQLSTATE
SQL
)" || true
  grep -q '^RO=off$' <<<"$out" || fail "${label}_read_only_not_disabled"
  grep -q '^STATE=42501$' <<<"$out" || fail "${label}_not_permission_denied($(sed -n 's/^STATE=//p' <<<"$out"))"
  echo "M5_READER $label=DENIED sqlstate=42501"
}
deny write_legacy "delete from dpg_app.banners where false;"
if [[ ",$schemas," == *",dpg_commerce,"* ]]; then
  deny insert_commerce "insert into dpg_commerce.events (entity, entity_id, actor, action) values ('order', 0, 'proof', 'note');"
  deny update_column_commerce "update dpg_commerce.orders set staff_note = staff_note where false;"
  deny truncate_commerce "truncate dpg_commerce.rate_buckets;"
  deny create_in_scope "create table dpg_commerce.proof_t(id int);"
  deny sequence_nextval "select nextval('dpg_commerce.orders_id_seq');"
  deny sequence_setval "select setval('dpg_commerce.orders_id_seq', 1);"
  deny execute_secdef_order_submit "select dpg_commerce.order_submit('{}'::jsonb, 'proof-key-1', '0123456789abcdef');"
  deny execute_secdef_rate_hit "select dpg_commerce.rate_hit('proof', 1, 1);"
  deny set_role_owner "set role dpg_commerce_owner;"
  [ "$(docker exec -i "$c" psql -U dpg_backup_reader -d "$db" -X -q -A -t -c "select count(*) >= 0 from dpg_commerce.orders")" = t ] || fail commerce_read
  echo 'M5_READER commerce_read=ALLOWED'
fi
sqlin -c "alter role dpg_backup_reader nobypassrls" >/dev/null
if docker exec "$c" pg_dump -U dpg_backup_reader -d "$db" --format=custom --schema=dpg_app -f /tmp/reader-rls.dump > /tmp/dpg42-rls.log 2>&1; then fail dump_succeeded_without_bypassrls; fi
grep -Eq 'row-level security|row security' /tmp/dpg42-rls.log || fail rls_refusal_not_observed
echo 'M5_READER without_bypassrls=FAILS (row-level security)'
rm -f /tmp/dpg42-reader-verify.txt /tmp/dpg42-commerce-verify.txt /tmp/dpg42-rls.log /tmp/dpg42-full.inv /tmp/dpg42-reader.inv
echo 'M5_READER status=PASS'
