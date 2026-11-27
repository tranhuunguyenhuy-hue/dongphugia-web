#!/usr/bin/env bash
# DPG-42: verify, decrypt and restore one backup bundle into an isolated, labelled scratch PostgreSQL container, then gate it.
# v2 (scope.json present): ONE ownership-preserving restore into database `restored` is the authoritative gate. The roles the
# source referenced are re-created first with their recorded attributes and memberships, plus the documented Supabase
# platform prerequisites (scripts/backup/scratch-platform-prereqs.sql) and required extensions; then row counts, content
# digests, manifest, ownership, per-object security (ACL with grantor/grant option, column/function/schema/default ACL, RLS
# enable/force, sequence and column/view definitions), roles and sequence safety must all match. The bundle's scope is only
# accepted if it equals a reviewed version in scripts/backup/backup-scope.json, and every v2 file/field must be present and
# mutually consistent; a bundle cannot be relabelled v1 by deleting files. A historical v1 bundle (no scope.json, no v2 field
# or file) is restored exactly as before (--no-owner) and reported coverage=limited (dpg_commerce NOT covered).
# Errors print sanitized classes only. Plaintext is removed on every exit path.
# Env: BUNDLE, AGE_IDENTITY, POSTGRES_IMAGE, REPO, optional CONTAINER (default scratch; left running on success for the reader
# proof), optional SCRATCH_PREREQS (default the reviewed prerequisites file).
set -euo pipefail
: "${BUNDLE:?}" "${AGE_IDENTITY:?}" "${POSTGRES_IMAGE:?}" "${REPO:?}"
c="${CONTAINER:-scratch}"
prereqs="${SCRATCH_PREREQS:-$REPO/scripts/backup/scratch-platform-prereqs.sql}"
source "$REPO/scripts/backup/m4-sanitize.sh"
ok=false
cleanup() {
  ( cd "$BUNDLE" 2>/dev/null && for f in identity.txt production.dump content.txt; do if [ -e "$f" ]; then shred -u "$f" 2>/dev/null || rm -f "$f"; fi; done ) || true
  if [ "$ok" != true ] && [ "$(docker inspect -f '{{index .Config.Labels "dpg42.scratch"}}' "$c" 2>/dev/null)" = 1 ]; then docker rm -f "$c" >/dev/null 2>&1 || true; fi
  return 0
}
trap cleanup EXIT
fail() { echo "M4_RESTORE status=FAIL reason=$1"; exit 1; }
cd "$BUNDLE"
test -s SHA256SUMS || fail checksums_missing
sha256sum --check --strict --quiet SHA256SUMS >/dev/null 2>&1 || fail checksum_mismatch
listed() { awk '{print $2}' SHA256SUMS | sed 's/^\*//' | grep -qx "$1"; }
for f in production.dump.age manifest.txt row-counts.txt objects.txt; do listed "$f" || fail "unlisted_file_$f"; done
v2_marker=false
for f in scope.json content.txt.age owners.txt security.txt roles.txt; do [ -e "$f" ] && v2_marker=true; done
grep -q '^scope_version=' manifest.txt && v2_marker=true
if [ -e scope.json ] && ! listed scope.json; then fail unlisted_file_scope.json; fi
if [ "$v2_marker" = true ] && [ ! -e scope.json ]; then fail v2_bundle_without_scope; fi
scope="$(node "$REPO/scripts/backup/backup-scope.mjs" resolve-bundle "$BUNDLE")" || fail scope_untrusted
version="$(sed -n 's/.*version=\([0-9]*\).*/\1/p' <<<"$scope")"; coverage="$(sed -n 's/.*coverage=\([a-z]*\).*/\1/p' <<<"$scope")"
schemas="$(sed -n 's/.*schemas=\([a-z0-9_,]*\).*/\1/p' <<<"$scope")"
echo "M4_RESTORE scope_version=$version coverage=$coverage schemas=$schemas"
[ "$coverage" = full ] || echo 'M4_RESTORE coverage_warning=dpg_commerce_NOT_covered (historical v1 bundle: legacy data only)'
field() { sed -n "s/^$1=//p" manifest.txt; }
if [ "$version" = 2 ]; then
  for f in scope.json content.txt.age owners.txt security.txt roles.txt; do listed "$f" || fail "v2_file_missing_$f"; done
  for k in backup_id source_sha plaintext_dump_sha256 plaintext_content_sha256 tables scope_version schemas discovered created_utc; do
    [ -n "$(field "$k")" ] || fail "v2_field_missing_$k"; done
  [ "$(field scope_version)" = 2 ] || fail manifest_scope_version_mismatch
  [ "$(field schemas)" = "$schemas" ] || fail manifest_schemas_mismatch
  [ "$(field tables)" = "$(wc -l < row-counts.txt)" ] || fail manifest_tables_mismatch
  cmp -s <(awk '{print $1}' row-counts.txt | cut -d. -f1 | sort -u) <(tr ',' '\n' <<<"$schemas" | sort) || fail counts_schemas_mismatch
fi

umask 077
printf '%s\n' "$AGE_IDENTITY" > identity.txt
age -d -i identity.txt -o production.dump production.dump.age 2>/dev/null || fail decrypt_failed
[ "$version" = 2 ] && { age -d -i identity.txt -o content.txt content.txt.age 2>/dev/null || fail decrypt_failed_content; }
shred -u identity.txt 2>/dev/null || rm -f identity.txt
expected_sha="$(field plaintext_dump_sha256)"
test -n "$expected_sha" && test "$(sha256sum production.dump | cut -d' ' -f1)" = "$expected_sha" || fail plaintext_checksum
if [ "$version" = 2 ]; then [ "$(sha256sum content.txt | cut -d' ' -f1)" = "$(field plaintext_content_sha256)" ] || fail content_checksum; fi

existing="$(docker inspect -f '{{index .Config.Labels "dpg42.scratch"}}' "$c" 2>/dev/null || true)"
if docker inspect "$c" >/dev/null 2>&1; then [ "$existing" = 1 ] || fail scratch_name_in_use_by_unlabelled_container; docker rm -f "$c" >/dev/null; fi
docker run -d --name "$c" --label dpg42.scratch=1 --network none -e POSTGRES_PASSWORD=scratch "$POSTGRES_IMAGE" >/dev/null
for _ in $(seq 1 90); do docker logs "$c" 2>&1 | grep -q "PostgreSQL init process complete" && docker exec "$c" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sql() { docker exec -i "$c" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
docker cp production.dump "$c":/tmp/production.dump
shred -u production.dump 2>/dev/null || rm -f production.dump
docker exec "$c" pg_restore -l /tmp/production.dump > toc.txt 2>/dev/null || fail archive_unreadable
if [ "$version" = 2 ]; then
  cmp -s <(sed -nE 's/^[0-9]+; [0-9]+ [0-9]+ TABLE DATA ([^ ]+) ([^ ]+) .*/\1.\2/p' toc.txt | sort) <(awk '{print $1}' row-counts.txt | sort) || fail toc_inventory_differs
fi
valid_role() { [[ "$1" =~ ^[a-z_][a-z0-9_]*$ ]] && [[ "$1" != pg_* ]]; }
if [ "$version" = 2 ]; then
  # Re-create every referenced role with its recorded attributes (no password) and memberships.
  while read -r _ r attrs; do
    valid_role "$r" || fail role_name_invalid
    opts="$(sed -E 's/super=true/SUPERUSER/; s/super=false/NOSUPERUSER/; s/inherit=true/INHERIT/; s/inherit=false/NOINHERIT/; s/createrole=true/CREATEROLE/; s/createrole=false/NOCREATEROLE/; s/createdb=true/CREATEDB/; s/createdb=false/NOCREATEDB/; s/login=true/LOGIN/; s/login=false/NOLOGIN/; s/replication=true/REPLICATION/; s/replication=false/NOREPLICATION/; s/bypassrls=true/BYPASSRLS/; s/bypassrls=false/NOBYPASSRLS/; s/connlimit=(-?[0-9]+)/CONNECTION LIMIT \1/' <<<"$attrs")"
    sql -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = '$r') then execute format('create role %I', '$r'); end if; end \$\$" >/dev/null </dev/null 2>>bootstrap.err || fail "role_bootstrap_$(m4_error_class bootstrap.err)"
    sql -c "alter role \"$r\" $opts" >/dev/null </dev/null 2>>bootstrap.err || fail "role_bootstrap_$(m4_error_class bootstrap.err)"
  done < <(grep '^roleattr ' roles.txt)
  while read -r _ r; do valid_role "$r" || [ "$r" = postgres ] || fail role_name_invalid
    sql -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = '$r') then execute format('create role %I nologin', '$r'); end if; end \$\$" >/dev/null </dev/null 2>>bootstrap.err || fail "role_bootstrap_$(m4_error_class bootstrap.err)"
  done < <(grep '^roleexists ' roles.txt)
  while read -r _ g m a i s; do valid_role "$g" || fail role_name_invalid; valid_role "$m" || [ "$m" = postgres ] || fail role_name_invalid
    sql -c "grant \"$g\" to \"$m\" with admin ${a#admin=}, inherit ${i#inherit=}, set ${s#set=}" >/dev/null </dev/null 2>>bootstrap.err || fail "role_bootstrap_$(m4_error_class bootstrap.err)"
  done < <(grep '^member ' roles.txt)
  sql -c "create database restored" >/dev/null 2>>bootstrap.err || fail scratch_database_create
  db=restored
else
  # v1 (historical): unchanged behaviour - NOLOGIN stubs for every referenced role, --no-owner restore into postgres.
  docker exec "$c" pg_restore -s -f /tmp/schema.sql /tmp/production.dump 2>/dev/null || fail archive_unreadable
  roles="$(docker exec "$c" grep -E '^(GRANT |REVOKE |ALTER .* OWNER TO |ALTER DEFAULT PRIVILEGES |CREATE POLICY )' /tmp/schema.sql \
    | grep -oE '(OWNER TO|FOR ROLE| TO| FROM) "?[a-z_][a-z0-9_]*"?(, "?[a-z_][a-z0-9_]*"?)*' \
    | sed -E 's/^.*(OWNER TO|FOR ROLE| TO| FROM) //' | tr ',' '\n' | tr -d '" '; sed -n 's/^role //p' objects.txt)"
  for role in $(printf '%s\n' $roles | sort -u); do
    case "$role" in public|current_user|session_user|current_role|pg_*) continue;; esac
    valid_role "$role" || fail role_name_invalid
    sql -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = '$role') then execute format('create role %I nologin', '$role'); end if; end \$\$" >/dev/null </dev/null 2>>bootstrap.err || fail "role_bootstrap_$(m4_error_class bootstrap.err)"
  done
  db=postgres
fi
sqldb() { docker exec -i "$c" psql -U postgres -d "$db" -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
sqldb -f - < "$prereqs" >/dev/null 2> prereq.err || fail "platform_prerequisites_$(m4_error_class prereq.err)"
if [ "$version" = 2 ]; then
  for e in $(sed -n 's/^ext //p' security.txt); do [[ "$e" =~ ^[a-z0-9_]+$ ]] || fail extension_name_invalid
    sqldb -c "create extension if not exists \"$e\"" >/dev/null 2>&1 || fail "extension_unavailable_$e"; done
  rc=0; docker exec "$c" pg_restore -U postgres -d "$db" --exit-on-error /tmp/production.dump > restore.log 2>&1 || rc=$?
else
  rc=0; docker exec "$c" pg_restore -U postgres -d "$db" --no-owner /tmp/production.dump > restore.log 2>&1 || rc=$?
fi
echo "M4_RESTORE pg_restore_exit=$rc$([ "$rc" = 0 ] || echo " error_class=$(m4_error_class restore.log)")"
# A failed restore stops here (sanitized class above), before any later check can report a misleading reason.
[ "$rc" = 0 ] || fail restore_failed
sqldb -v schemas="$schemas" -f - < "$REPO/scripts/backup/m5-content.sql" 2>/dev/null | sed '/^$/d' | sort > restored-content.txt
awk '{print $1" "$2}' restored-content.txt | sort > restored-counts.txt
sqldb -v schemas="$schemas" -v manifest_version="$version" -f - < "$REPO/scripts/backup/m5-manifest.sql" > restored-objects.txt 2>/dev/null || true
gate_args=()
if [ "$version" = 2 ]; then
  sqldb -v schemas="$schemas" -f - < "$REPO/scripts/backup/m5-ownership.sql" > restored-owners.txt 2>/dev/null || true
  sqldb -v schemas="$schemas" -f - < "$REPO/scripts/backup/m5-security.sql" > restored-security.txt 2>/dev/null || true
  sqldb -v schemas="$schemas" -f - < "$REPO/scripts/backup/m5-roles.sql" > restored-roles.txt 2>/dev/null || true
  gate_args=(--content content.txt restored-content.txt --owners owners.txt restored-owners.txt --security security.txt restored-security.txt --roles roles.txt restored-roles.txt)
  # Sequence safety (values are non-transactional): the NEXT value each owned sequence would return must be beyond the
  # restored column maximum; descending, cycling or unowned-but-default sequences fail closed.
  sqldb -v schemas="$schemas" > seq-safety.txt 2>/dev/null <<'SQL' || fail sequence_check_failed
select format('select %L || '' '' || (case when s.seqincrement <= 0 or s.seqcycle then ''unsupported'' when (select case when is_called then last_value + s.seqincrement else last_value end from %s) > coalesce((select max(%I) from %I.%I), 0) then ''safe'' else ''unsafe'' end) from pg_sequence s where s.seqrelid = %s',
              n.nspname || '.' || sc.relname, sc.oid::regclass, a.attname, n.nspname, t.relname, sc.oid)
  from pg_depend d join pg_class sc on sc.oid = d.objid and sc.relkind = 'S' join pg_class t on t.oid = d.refobjid
  join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid join pg_namespace n on n.oid = t.relnamespace
  where d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i') and n.nspname = any(string_to_array(:'schemas', ',')) order by 1
\gexec
SQL
  if grep -Eq ' (unsafe|unsupported)$' seq-safety.txt; then sed -nE 's/^(.*) (unsafe|unsupported)$/M4_RESTORE sequence_\2 \1/p' seq-safety.txt; fail sequence_not_safe; fi
  echo "M4_RESTORE sequences_safe=$(grep -c ' safe$' seq-safety.txt || true)"
fi
node "$REPO/scripts/backup/m5-restore-gate.mjs" "$rc" restore.log row-counts.txt restored-counts.txt objects.txt restored-objects.txt \
  --scope-version "$version" --coverage "$coverage" "${gate_args[@]}" || fail gate
rm -f restore.log prereq.err bootstrap.err restored-content.txt
ok=true
echo "M4_RESTORE status=PASS scope_version=$version coverage=$coverage schemas=$schemas database=$db tables=$(wc -l < row-counts.txt) counts=identical objects_acl=identical$([ "$version" = 2 ] && echo ' content=identical owners=identical security=identical roles=identical ownership_preserving=true')"
