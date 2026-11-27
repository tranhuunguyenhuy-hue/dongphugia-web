#!/usr/bin/env bash
# DPG-42: one consistent, encrypted logical backup of the approved Production backup scope.
# Scope discovery, row counts, content digests, the schema/ACL manifest, per-object security, roles/ownership and pg_dump
# all read ONE exported snapshot (scripts/backup/exported-snapshot.sh): concurrent commits are simply not in the snapshot,
# and no lock beyond pg_dump's ordinary ACCESS SHARE is taken. After the dump the live schema list is re-checked so a schema
# created during the dump fails closed. Plaintext (dump, content digests) never leaves the private work dir unencrypted and
# is shredded on every exit path. Errors are reported as sanitized classes only, never raw server text or row values.
# Env: DATABASE_URL, POSTGRES_IMAGE, AGE_RECIPIENT, WORK (empty dir), REPO (checkout), optional DOCKER_NETWORK (default host).
set -euo pipefail
: "${DATABASE_URL:?}" "${POSTGRES_IMAGE:?}" "${AGE_RECIPIENT:?}" "${WORK:?}" "${REPO:?}"
net="${DOCKER_NETWORK:-host}"
mkdir -p "$WORK"; chmod 700 "$WORK"
source "$REPO/scripts/backup/m4-sanitize.sh"
schemas="$(node "$REPO/scripts/backup/backup-scope.mjs" schemas)"
schema_args=(); IFS=',' read -r -a list <<<"$schemas"; for s in "${list[@]}"; do schema_args+=("--schema=$s"); done

cat > "$WORK/psql" <<WRAP
#!/usr/bin/env bash
exec docker run --rm -i --network "$net" -v "$WORK:$WORK" -e DATABASE_URL "$POSTGRES_IMAGE" psql "\$@"
WRAP
chmod 700 "$WORK/psql"
export PSQL_BIN="$WORK/psql"
source "$REPO/scripts/backup/exported-snapshot.sh"
done_ok=false
cleanup() {
  cleanup_snapshot_keeper 'ROLLBACK'
  for f in production.dump content.txt toc.txt psql snapshot.id snapshot-control snapshot-keeper.output snapshot-keeper.error session.err dump.err discovered-now.txt; do
    # Only regular files are shredded: shred on the snapshot-control FIFO would block forever waiting for a reader.
    if [ -f "$WORK/$f" ] && [ ! -L "$WORK/$f" ]; then shred -u "$WORK/$f" 2>/dev/null || rm -f "$WORK/$f"
    elif [ -e "$WORK/$f" ] || [ -L "$WORK/$f" ]; then rm -f "$WORK/$f"; fi
  done
  if [ "$done_ok" != true ]; then rm -f "$WORK"/production.dump.age "$WORK"/content.txt.age "$WORK"/SHA256SUMS; fi
  return 0
}
trap cleanup EXIT
fail() { echo "M4_BACKUP status=FAIL stage=$1${2:+ reason=$2}"; exit 1; }

start_snapshot_keeper "$DATABASE_URL" "$WORK" || fail snapshot "$snapshot_keeper_failure_reason"
SNAPSHOT_ID="$exported_snapshot_id"
{
  printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET TRANSACTION SNAPSHOT %s;\n' "'$SNAPSHOT_ID'"
  # each SQL file may end without ";" (it is also run alone with -f): terminate it before the next one
  printf '\\o %s\n' "$WORK/discovered.txt"
  printf "select n.nspname from pg_namespace n where n.nspname like 'dpg\\\\_%%' and exists (select 1 from pg_class c where c.relnamespace = n.oid and c.relkind in ('r','p')) order by 1;\n"
  printf '\\o %s\n' "$WORK/content.txt"; cat "$REPO/scripts/backup/m5-content.sql"; printf "\n;\n"
  printf '\\o %s\n' "$WORK/objects.txt"; cat "$REPO/scripts/backup/m5-manifest.sql"; printf "\n;\n"
  printf '\\o %s\n' "$WORK/owners.txt"; cat "$REPO/scripts/backup/m5-ownership.sql"; printf "\n;\n"
  printf '\\o %s\n' "$WORK/security.txt"; cat "$REPO/scripts/backup/m5-security.sql"; printf "\n;\n"
  printf '\\o %s\n' "$WORK/roles.txt"; cat "$REPO/scripts/backup/m5-roles.sql"; printf "\n;\n"
  printf '\\o\nCOMMIT;\n'
} | "$PSQL_BIN" "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -v schemas="$schemas" -v manifest_version=2 -f - 2> "$WORK/session.err" \
  || fail snapshot_manifest "$(m4_error_class "$WORK/session.err")"
node "$REPO/scripts/backup/backup-scope.mjs" check-discovered "$WORK/discovered.txt" | sed 's/^M4_SCOPE/M4_BACKUP snapshot_scope/' || fail snapshot_scope uncovered_or_missing_schema
docker run --rm --network "$net" -e DATABASE_URL "$POSTGRES_IMAGE" sh -c 'snap="$1"; shift; pg_dump "$DATABASE_URL" --format=custom --compress=6 --no-owner --snapshot="$snap" "$@"' \
  sh "$SNAPSHOT_ID" "${schema_args[@]}" > "$WORK/production.dump" 2> "$WORK/dump.err" \
  || fail dump "$(m4_error_class "$WORK/dump.err")"
finalize_snapshot_keeper 'COMMIT' || fail snapshot_release
# Drift re-check against the live catalog: a dpg_* schema created while the dump ran is not in this snapshot -> fail closed.
"$PSQL_BIN" "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -c "select n.nspname from pg_namespace n where n.nspname like 'dpg\_%' and exists (select 1 from pg_class c where c.relnamespace = n.oid and c.relkind in ('r','p')) order by 1" > "$WORK/discovered-now.txt" 2>/dev/null \
  || fail drift_recheck query_failed
cmp -s "$WORK/discovered.txt" "$WORK/discovered-now.txt" || fail drift_recheck schema_set_changed_during_dump

# Completeness: every scope schema has tables; the archive's TABLE DATA inventory equals the snapshot's table inventory
# exactly (no partial, truncated or extra table can pass); manifest, ownership, security and roles are non-empty.
sed -i '/^$/d' "$WORK/content.txt" "$WORK/objects.txt" "$WORK/owners.txt" "$WORK/security.txt" "$WORK/roles.txt"
awk '{print $1" "$2}' "$WORK/content.txt" | sort > "$WORK/row-counts.txt"
tables="$(wc -l < "$WORK/row-counts.txt")"
for s in "${list[@]}"; do grep -q "^$s\." "$WORK/row-counts.txt" || fail completeness "schema_without_tables_$s"; done
for f in objects.txt owners.txt security.txt roles.txt; do test -s "$WORK/$f" || fail completeness "${f%.txt}_empty"; done
docker run --rm -i "$POSTGRES_IMAGE" pg_restore -l < "$WORK/production.dump" > "$WORK/toc.txt" 2>/dev/null || fail completeness archive_unreadable
cmp -s <(sed -nE 's/^[0-9]+; [0-9]+ [0-9]+ TABLE DATA ([^ ]+) ([^ ]+) .*/\1.\2/p' "$WORK/toc.txt" | sort) <(awk '{print $1}' "$WORK/row-counts.txt" | sort) \
  || fail completeness table_data_inventory_differs

node "$REPO/scripts/backup/backup-scope.mjs" write-bundle-scope "$WORK/scope.json"
scope_version="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version))' "$WORK/scope.json")"
dump_sha="$(sha256sum "$WORK/production.dump" | cut -d' ' -f1)"
content_sha="$(sha256sum "$WORK/content.txt" | cut -d' ' -f1)"
# content digests are derived from row data: they travel encrypted with the dump, never as plaintext artifact files
age -r "$AGE_RECIPIENT" -o "$WORK/production.dump.age" "$WORK/production.dump"
age -r "$AGE_RECIPIENT" -o "$WORK/content.txt.age" "$WORK/content.txt"
{ echo "backup_id=m4-${GITHUB_RUN_ID:-local}"; echo "source_sha=${GITHUB_SHA:-local}"; echo "plaintext_dump_sha256=$dump_sha"
  echo "plaintext_content_sha256=$content_sha"; echo "tables=$tables"; echo "scope_version=$scope_version"; echo "schemas=$schemas"
  echo "discovered=$(paste -sd, "$WORK/discovered.txt")"; echo "created_utc=$(date -u +%FT%TZ)"; } > "$WORK/manifest.txt"
rm -f "$WORK/discovered.txt"
( cd "$WORK" && sha256sum production.dump.age content.txt.age manifest.txt row-counts.txt objects.txt scope.json owners.txt security.txt roles.txt > SHA256SUMS )
done_ok=true
echo "M4_BACKUP status=PASS stage=dump scope_version=$scope_version schemas=$schemas tables=$tables dump_sha256=$dump_sha encrypted_bytes=$(stat -c %s "$WORK/production.dump.age")"
exit 0
