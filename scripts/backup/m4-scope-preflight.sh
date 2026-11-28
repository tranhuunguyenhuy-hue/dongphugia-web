#!/usr/bin/env bash
# DPG-42 fail-closed scope preflight (read-only catalog queries, no row data), run by the backup probe BEFORE any dump:
#  1. every dpg_* schema that contains tables is in the reviewed scope (or an explicit reviewed exclusion), and every
#     approved schema exists - a future dpg_core cannot be silently omitted;
#  2. the connection IS the least-privilege reader `dpg_backup_reader` with exactly the 001 attributes. Scope v2 has no
#     owner/superuser fallback: any other role fails (re-enabling a fallback needs a separate, explicitly labelled approval);
#  3. the reader can read the whole scope (schema USAGE, SELECT on every relation and sequence) and has no write or
#     escalation path: no table/column DML (incl. views), no CREATE, no sequence USAGE/UPDATE, no grant option, no EXECUTE
#     on SECURITY DEFINER functions, no role membership.
# Env: DATABASE_URL, POSTGRES_IMAGE, REPO, optional DOCKER_NETWORK (default host).
set -euo pipefail
: "${DATABASE_URL:?}" "${POSTGRES_IMAGE:?}" "${REPO:?}"
net="${DOCKER_NETWORK:-host}"
source "$REPO/scripts/backup/m4-sanitize.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pg() { docker run --rm -i --network "$net" -e DATABASE_URL "$POSTGRES_IMAGE" psql "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 "$@" 2> "$tmp/err"; }
schemas="$(node "$REPO/scripts/backup/backup-scope.mjs" schemas)"
pg -c "select n.nspname from pg_namespace n where n.nspname like 'dpg\_%' and exists (select 1 from pg_class c where c.relnamespace = n.oid and c.relkind in ('r','p')) order by 1" > "$tmp/discovered.txt" \
  || { echo "M4_SCOPE status=FAIL reason=discovery_$(m4_error_class "$tmp/err")"; exit 1; }
node "$REPO/scripts/backup/backup-scope.mjs" check-discovered "$tmp/discovered.txt"
out="$(pg -v schemas="$schemas" <<'SQL'
with s as (select unnest(string_to_array(:'schemas', ',')) as n),
me as (select r.* from pg_roles r where r.rolname = current_user),
rel as (select c.oid, c.relkind, c.relacl from pg_class c join pg_namespace n on n.oid = c.relnamespace join s on s.n = n.nspname where c.relkind in ('r','p','v','m','S','f'))
select (select rolname from me)
  || '|' || (select (rolcanlogin and rolbypassrls and not rolsuper and not rolcreaterole and not rolcreatedb and not rolreplication and not rolinherit and rolconnlimit = 2)::text from me)
  || '|' || current_setting('transaction_read_only')
  || '|' || (select count(*) from pg_auth_members m where m.member = (select oid from me))
  || '|' || (select count(*) from s where not has_schema_privilege(current_user, s.n, 'USAGE'))
  || '|' || (select count(*) from s where has_schema_privilege(current_user, s.n, 'CREATE'))
  || '|' || (select count(*) from rel where case when relkind <> 'S' then not has_table_privilege(current_user, oid, 'SELECT') else false end)
  || '|' || (select count(*) from rel where case when relkind = 'S' then not has_sequence_privilege(current_user, oid, 'SELECT') else false end)
  || '|' || (select count(*) from rel where case when relkind <> 'S' then has_table_privilege(current_user, oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                                                   or has_any_column_privilege(current_user, oid, 'INSERT,UPDATE,REFERENCES') else false end)
  || '|' || (select count(*) from rel where case when relkind = 'S' then has_sequence_privilege(current_user, oid, 'USAGE,UPDATE') else false end)
  || '|' || ((select count(*) from rel cross join lateral aclexplode(rel.relacl) a where a.grantee = (select oid from me) and a.is_grantable)
             + (select count(*) from pg_attribute att join rel on rel.oid = att.attrelid cross join lateral aclexplode(att.attacl) a where att.attacl is not null and a.grantee = (select oid from me) and a.is_grantable))
  || '|' || (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace join s on s.n = n.nspname where p.prosecdef and has_function_privilege(current_user, p.oid, 'EXECUTE'))
  || '|' || (select count(*) from rel)
SQL
)" || { echo "M4_SCOPE status=FAIL reason=privilege_query_$(m4_error_class "$tmp/err")"; exit 1; }
IFS='|' read -r role attrs_ok readonly memberships no_usage can_create no_select no_seq_select writable seq_mutable grantable secdef_exec relations <<<"$out"
echo "M4_SCOPE privileges role=$role schemas=$schemas relations=$relations attributes_ok=$attrs_ok read_only=$readonly memberships=$memberships missing_usage=$no_usage create=$can_create missing_select=$no_select missing_sequence_select=$no_seq_select writable=$writable sequence_mutable=$seq_mutable grant_option=$grantable secdef_executable=$secdef_exec"
fail=''
[ "$role" = dpg_backup_reader ] || fail="$fail,not_least_privilege_reader"
[ "$attrs_ok" = true ] || fail="$fail,reader_attributes_differ"
[ "$readonly" = on ] || fail="$fail,reader_not_read_only"
[ "$memberships" = 0 ] || fail="$fail,reader_has_memberships"
[ "$no_usage" = 0 ] || fail="$fail,reader_missing_schema_usage"
[ "$can_create" = 0 ] || fail="$fail,reader_can_create"
[ "$no_select" = 0 ] || fail="$fail,reader_missing_table_select"
[ "$no_seq_select" = 0 ] || fail="$fail,reader_missing_sequence_select"
[ "$writable" = 0 ] || fail="$fail,reader_has_write_privileges"
[ "$seq_mutable" = 0 ] || fail="$fail,reader_can_mutate_sequences"
[ "$grantable" = 0 ] || fail="$fail,reader_has_grant_option"
[ "$secdef_exec" = 0 ] || fail="$fail,reader_can_execute_security_definer"
[ "$relations" -gt 0 ] || fail="$fail,scope_empty"
if [ -n "$fail" ]; then echo "M4_SCOPE status=FAIL reason=${fail#,}"; exit 1; fi
echo 'M4_SCOPE status=PASS'
