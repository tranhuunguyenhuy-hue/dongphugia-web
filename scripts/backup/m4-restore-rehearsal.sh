#!/usr/bin/env bash
# DPG-42: verify, decrypt and restore one backup bundle into an isolated scratch PostgreSQL container, then gate on exact
# row counts, content digests, schema objects/ACLs and (v2) ownership incl. SECURITY DEFINER owners. The bundle's scope is
# accepted only if it equals a reviewed version in scripts/backup/backup-scope.json; a historical bundle without scope.json
# is restored with the v1 scope and reported as coverage=limited (dpg_commerce NOT covered) - never as full recovery.
# Env: BUNDLE (dir with SHA256SUMS), AGE_IDENTITY, POSTGRES_IMAGE, REPO, optional CONTAINER (default scratch, left running).
set -euo pipefail
: "${BUNDLE:?}" "${AGE_IDENTITY:?}" "${POSTGRES_IMAGE:?}" "${REPO:?}"
c="${CONTAINER:-scratch}"
cd "$BUNDLE"
test -s SHA256SUMS || { echo 'M4_RESTORE status=FAIL reason=checksums_missing'; exit 1; }
sha256sum --check --strict SHA256SUMS >/dev/null || { echo 'M4_RESTORE status=FAIL reason=checksum_mismatch'; exit 1; }
listed() { awk '{print $2}' SHA256SUMS | sed 's/^\*//' | grep -qx "$1"; }
for f in production.dump.age manifest.txt row-counts.txt objects.txt; do listed "$f" || { echo "M4_RESTORE status=FAIL reason=unlisted_file file=$f"; exit 1; }; done
if [ -e scope.json ] && ! listed scope.json; then echo 'M4_RESTORE status=FAIL reason=unlisted_file file=scope.json'; exit 1; fi
scope="$(node "$REPO/scripts/backup/backup-scope.mjs" resolve-bundle "$BUNDLE")" || { echo "$scope"; echo 'M4_RESTORE status=FAIL reason=scope_untrusted'; exit 1; }
version="$(sed -n 's/.*version=\([0-9]*\).*/\1/p' <<<"$scope")"; coverage="$(sed -n 's/.*coverage=\([a-z]*\).*/\1/p' <<<"$scope")"
schemas="$(sed -n 's/.*schemas=\([a-z0-9_,]*\).*/\1/p' <<<"$scope")"
echo "M4_RESTORE scope_version=$version coverage=$coverage schemas=$schemas"
if [ "$coverage" != full ]; then echo 'M4_RESTORE coverage_warning=dpg_commerce_NOT_covered (historical v1 bundle: legacy data only)'; fi
if [ "$version" = 2 ]; then for f in scope.json content.txt owners.txt; do listed "$f" || { echo "M4_RESTORE status=FAIL reason=v2_file_missing file=$f"; exit 1; }; done; fi

umask 077
printf '%s\n' "$AGE_IDENTITY" > identity.txt
age -d -i identity.txt -o production.dump production.dump.age || { rm -f identity.txt; echo 'M4_RESTORE status=FAIL reason=decrypt_failed'; exit 1; }
rm -f identity.txt
expected_sha="$(sed -n 's/^plaintext_dump_sha256=//p' manifest.txt)"
test -n "$expected_sha" && test "$(sha256sum production.dump | cut -d' ' -f1)" = "$expected_sha" || { echo 'M4_RESTORE status=FAIL reason=plaintext_checksum'; exit 1; }

docker rm -f "$c" >/dev/null 2>&1 || true
docker run -d --name "$c" -e POSTGRES_PASSWORD=scratch "$POSTGRES_IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$c" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sql() { docker exec -i "$c" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
docker cp production.dump "$c":/tmp/production.dump
rm -f production.dump
# NOLOGIN stubs for every role the archive references (owners, GRANT/REVOKE, default ACLs, policies) plus the manifest's
# role lines: names only, no credentials. Taken from the archive itself so no referenced role can be missed.
docker exec "$c" pg_restore -s -f /tmp/schema.sql /tmp/production.dump > schema-list.log 2>&1 || { echo 'M4_RESTORE status=FAIL reason=archive_unreadable'; exit 1; }
roles="$(docker exec "$c" grep -E '^(GRANT |REVOKE |ALTER .* OWNER TO |ALTER DEFAULT PRIVILEGES |CREATE POLICY )' /tmp/schema.sql \
  | grep -oE '(OWNER TO|FOR ROLE| TO| FROM) "?[a-z_][a-z0-9_]*"?(, "?[a-z_][a-z0-9_]*"?)*' \
  | sed -E 's/^.*(OWNER TO|FOR ROLE| TO| FROM) //' | tr ',' '\n' | tr -d '" '; sed -n 's/^role //p' objects.txt)"
for role in $(printf '%s\n' $roles | sort -u); do
  case "$role" in public|current_user|session_user|current_role|pg_*) continue;; esac
  [[ "$role" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "M4_RESTORE status=FAIL reason=role_name_invalid"; exit 1; }
  sql -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = '$role') then execute format('create role %I nologin', '$role'); end if; end \$\$"
done
# Supabase platform helpers referenced by some policies (scratch only; a real recovery restores into a Supabase project).
sql -c "create schema if not exists auth; create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid'; create or replace function auth.role() returns text language sql stable as 'select null::text'; create or replace function auth.jwt() returns jsonb language sql stable as 'select null::jsonb'"
gate_args=()
rc=0; docker exec "$c" pg_restore -U postgres -d postgres --no-owner /tmp/production.dump > restore.log 2>&1 || rc=$?
echo "M4_RESTORE pg_restore_exit=$rc"
{ cat "$REPO/scripts/backup/m5-content.sql"; } | sql -v schemas="$schemas" -f - | sed '/^$/d' | sort > restored-content.txt
awk '{print $1" "$2}' restored-content.txt | sort > restored-counts.txt
sql -v schemas="$schemas" -v manifest_version="$version" -f - < "$REPO/scripts/backup/m5-manifest.sql" > restored-objects.txt
# Sequence safety: every sequence owned by a column in scope must be at or beyond the restored column maximum, so new rows
# after a recovery can never collide with restored ones (values are not compared: sequences are non-transactional).
sql -v schemas="$schemas" > seq-safety.txt <<'SQL'
select format('select %L || '' '' || ((select last_value from %s) >= coalesce((select max(%I) from %I.%I), 0))::text', n.nspname || '.' || s.relname, s.oid::regclass, a.attname, n.nspname, t.relname)
  from pg_depend d join pg_class s on s.oid = d.objid and s.relkind = 'S' join pg_class t on t.oid = d.refobjid
  join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid join pg_namespace n on n.oid = t.relnamespace
  where d.classid = 'pg_class'::regclass and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i') and n.nspname = any(string_to_array(:'schemas', ',')) order by 1
\gexec
SQL
if grep -q ' false$' seq-safety.txt; then grep ' false$' seq-safety.txt | sed 's/^/M4_RESTORE sequence_unsafe /'; echo 'M4_RESTORE status=FAIL reason=sequence_behind_restored_rows'; exit 1; fi
echo "M4_RESTORE sequences_safe=$(grep -c ' true$' seq-safety.txt || true)"
if [ "$version" = 2 ]; then
  # Second, ownership-preserving restore: SECURITY DEFINER functions, tables and sequences keep their reviewed owners.
  sql -c "create database owned"
  orc=0; docker exec "$c" pg_restore -U postgres -d owned /tmp/production.dump > restore-owned.log 2>&1 || orc=$?
  echo "M4_RESTORE owned_restore_exit=$orc"
  test "$orc" = 0 && ! grep -Eq '^pg_restore: (error|warning: errors ignored)' restore-owned.log || { echo 'M4_RESTORE status=FAIL reason=ownership_restore_failed'; exit 1; }
  docker exec -i "$c" psql -U postgres -d owned -X -q -A -t -v ON_ERROR_STOP=1 -v schemas="$schemas" -f - < "$REPO/scripts/backup/m5-ownership.sql" > restored-owners.txt
  gate_args=(--content content.txt restored-content.txt --owners owners.txt restored-owners.txt)
fi
node "$REPO/scripts/backup/m5-restore-gate.mjs" "$rc" restore.log row-counts.txt restored-counts.txt objects.txt restored-objects.txt \
  --scope-version "$version" --coverage "$coverage" "${gate_args[@]}"
echo "M4_RESTORE status=PASS scope_version=$version coverage=$coverage schemas=$schemas tables=$(wc -l < row-counts.txt) counts=identical objects_acl=identical$([ "$version" = 2 ] && echo ' content=identical owners=identical')"
