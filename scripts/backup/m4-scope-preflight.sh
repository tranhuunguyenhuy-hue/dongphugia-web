#!/usr/bin/env bash
# DPG-42 fail-closed scope preflight (read-only catalog queries, no row data), run by the backup probe BEFORE any dump:
#  1. every dpg_* schema that contains tables is in the reviewed scope (or an explicit reviewed exclusion), and every
#     approved schema exists - a future dpg_core cannot be silently omitted;
#  2. the least-privilege reader can read the whole scope (schema USAGE, SELECT on every relation and sequence) and has
#     no write path: no table DML, no sequence USAGE/UPDATE, no EXECUTE on any SECURITY DEFINER function in scope.
# Env: DATABASE_URL, POSTGRES_IMAGE, REPO, optional DOCKER_NETWORK (default host), READER_EXPECTED (default dpg_backup_reader).
set -euo pipefail
: "${DATABASE_URL:?}" "${POSTGRES_IMAGE:?}" "${REPO:?}"
net="${DOCKER_NETWORK:-host}"
pg() { docker run --rm -i --network "$net" -e DATABASE_URL "$POSTGRES_IMAGE" psql "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
schemas="$(node "$REPO/scripts/backup/backup-scope.mjs" schemas)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pg -c "select n.nspname from pg_namespace n where n.nspname like 'dpg\_%' and exists (select 1 from pg_class c where c.relnamespace = n.oid and c.relkind in ('r','p')) order by 1" > "$tmp/discovered.txt"
node "$REPO/scripts/backup/backup-scope.mjs" check-discovered "$tmp/discovered.txt"
current="$(pg -c 'select current_user')"
if [ "$current" != "${READER_EXPECTED:-dpg_backup_reader}" ]; then
  echo "M4_SCOPE privileges=SKIPPED reason=not_least_privilege_reader current_user=$current"; exit 0
fi
out="$(pg -v schemas="$schemas" <<'SQL'
with s as (select unnest(string_to_array(:'schemas', ',')) as n),
rel as (select c.oid, c.relkind, n.nspname from pg_class c join pg_namespace n on n.oid = c.relnamespace join s on s.n = n.nspname where c.relkind in ('r','p','v','m','S'))
select (select count(*) from s where not has_schema_privilege(current_user, s.n, 'USAGE'))
  || '|' || (select count(*) from rel where case when relkind <> 'S' then not has_table_privilege(current_user, oid, 'SELECT') else false end)
  || '|' || (select count(*) from rel where case when relkind = 'S' then not has_sequence_privilege(current_user, oid, 'SELECT') else false end)
  || '|' || (select count(*) from rel where relkind in ('r','p') and has_table_privilege(current_user, oid, 'INSERT,UPDATE,DELETE,TRUNCATE'))
  || '|' || (select count(*) from rel where case when relkind = 'S' then has_sequence_privilege(current_user, oid, 'USAGE,UPDATE') else false end)
  || '|' || (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace join s on s.n = n.nspname
             where p.prosecdef and has_function_privilege(current_user, p.oid, 'EXECUTE'))
  || '|' || (select count(*) from rel)
SQL
)"
IFS='|' read -r no_usage no_select no_seq_select writable seq_mutable secdef_exec relations <<<"$out"
echo "M4_SCOPE privileges schemas=$schemas relations=$relations missing_usage=$no_usage missing_select=$no_select missing_sequence_select=$no_seq_select writable=$writable sequence_mutable=$seq_mutable secdef_executable=$secdef_exec"
fail=''
[ "$no_usage" = 0 ] || fail="$fail,reader_missing_schema_usage"
[ "$no_select" = 0 ] || fail="$fail,reader_missing_table_select"
[ "$no_seq_select" = 0 ] || fail="$fail,reader_missing_sequence_select"
[ "$writable" = 0 ] || fail="$fail,reader_has_write_privileges"
[ "$seq_mutable" = 0 ] || fail="$fail,reader_can_mutate_sequences"
[ "$secdef_exec" = 0 ] || fail="$fail,reader_can_execute_security_definer"
[ "$relations" -gt 0 ] || fail="$fail,scope_empty"
if [ -n "$fail" ]; then echo "M4_SCOPE status=FAIL reason=${fail#,}"; exit 1; fi
echo 'M4_SCOPE status=PASS'
