#!/usr/bin/env bash
# DPG-42: one consistent, encrypted logical backup of the approved Production backup scope.
# Row counts, content digests, the schema/ACL manifest, ownership and pg_dump all read ONE exported snapshot
# (scripts/backup/exported-snapshot.sh), so concurrent commits never make them disagree and no table lock is taken
# beyond pg_dump's ordinary ACCESS SHARE locks. Plaintext never leaves the private work dir and is shredded after age.
# Env: DATABASE_URL, POSTGRES_IMAGE, AGE_RECIPIENT, WORK (empty dir), REPO (checkout), optional DOCKER_NETWORK (default host).
set -euo pipefail
: "${DATABASE_URL:?}" "${POSTGRES_IMAGE:?}" "${AGE_RECIPIENT:?}" "${WORK:?}" "${REPO:?}"
net="${DOCKER_NETWORK:-host}"
mkdir -p "$WORK"; chmod 700 "$WORK"
schemas="$(node "$REPO/scripts/backup/backup-scope.mjs" schemas)"
schema_args=(); IFS=',' read -r -a list <<<"$schemas"; for s in "${list[@]}"; do schema_args+=("--schema=$s"); done

# psql/pg_dump from the pinned image; the private work dir is mounted at the same path so \o files land in it.
cat > "$WORK/psql" <<WRAP
#!/usr/bin/env bash
exec docker run --rm -i --network "$net" -v "$WORK:$WORK" -e DATABASE_URL "$POSTGRES_IMAGE" psql "\$@"
WRAP
chmod 700 "$WORK/psql"
export PSQL_BIN="$WORK/psql"
source "$REPO/scripts/backup/exported-snapshot.sh"
trap "cleanup_snapshot_keeper 'ROLLBACK'" EXIT

start_snapshot_keeper "$DATABASE_URL" "$WORK" || { echo "M4_BACKUP status=FAIL stage=snapshot reason=$snapshot_keeper_failure_reason"; exit 1; }
SNAPSHOT_ID="$exported_snapshot_id"
{
  printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET TRANSACTION SNAPSHOT %s;\n' "'$SNAPSHOT_ID'"
  # each SQL file may end without ";" (it is also run alone with -f): terminate it before the next one
  printf '\\o %s\n' "$WORK/content.txt"; cat "$REPO/scripts/backup/m5-content.sql"; printf "\n;\n"
  printf '\\o %s\n' "$WORK/objects.txt"; cat "$REPO/scripts/backup/m5-manifest.sql"; printf "\n;\n"
  printf '\\o %s\n' "$WORK/owners.txt"; cat "$REPO/scripts/backup/m5-ownership.sql"; printf "\n;\n"
  printf '\\o\nCOMMIT;\n'
} | "$PSQL_BIN" "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 -v schemas="$schemas" -v manifest_version=2 -f - \
  || { echo 'M4_BACKUP status=FAIL stage=snapshot_manifest'; exit 1; }
docker run --rm --network "$net" -e DATABASE_URL "$POSTGRES_IMAGE" sh -c 'snap="$1"; shift; pg_dump "$DATABASE_URL" --format=custom --compress=6 --no-owner --snapshot="$snap" "$@"' \
  sh "$SNAPSHOT_ID" "${schema_args[@]}" > "$WORK/production.dump" \
  || { echo 'M4_BACKUP status=FAIL stage=dump'; exit 1; }
finalize_snapshot_keeper 'COMMIT' || { echo 'M4_BACKUP status=FAIL stage=snapshot_release'; exit 1; }
trap - EXIT

# Completeness: every scope schema has tables, every counted table has a TABLE DATA entry in the archive (no partial or
# truncated dump can pass), and the manifest/ownership are non-empty.
sed -i '/^$/d' "$WORK/content.txt" "$WORK/objects.txt" "$WORK/owners.txt"
awk '{print $1" "$2}' "$WORK/content.txt" | sort > "$WORK/row-counts.txt"
tables="$(wc -l < "$WORK/row-counts.txt")"
for s in "${list[@]}"; do grep -q "^$s\." "$WORK/row-counts.txt" || { echo "M4_BACKUP status=FAIL stage=completeness reason=schema_without_tables schema=$s"; exit 1; }; done
test -s "$WORK/objects.txt" && test -s "$WORK/owners.txt" || { echo 'M4_BACKUP status=FAIL stage=completeness reason=manifest_empty'; exit 1; }
docker run --rm -i "$POSTGRES_IMAGE" pg_restore -l < "$WORK/production.dump" > "$WORK/toc.txt" || { echo 'M4_BACKUP status=FAIL stage=completeness reason=archive_unreadable'; exit 1; }
missing=0
while read -r t _; do s="${t%%.*}"; n="${t#*.}"; grep -Eq "TABLE DATA $s $n " "$WORK/toc.txt" || { echo "M4_BACKUP missing_table_data $t"; missing=$((missing+1)); }; done < "$WORK/row-counts.txt"
test "$missing" = 0 || { echo "M4_BACKUP status=FAIL stage=completeness reason=table_data_missing count=$missing"; exit 1; }
rm -f "$WORK/toc.txt"

node "$REPO/scripts/backup/backup-scope.mjs" write-bundle-scope "$WORK/scope.json"
dump_sha="$(sha256sum "$WORK/production.dump" | cut -d' ' -f1)"
age -r "$AGE_RECIPIENT" -o "$WORK/production.dump.age" "$WORK/production.dump"
shred -u "$WORK/production.dump" 2>/dev/null || rm -f "$WORK/production.dump"
scope_version="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version))' "$WORK/scope.json")"
{ echo "backup_id=m4-${GITHUB_RUN_ID:-local}"; echo "source_sha=${GITHUB_SHA:-local}"; echo "plaintext_dump_sha256=$dump_sha"; echo "tables=$tables"
  echo "scope_version=$scope_version"; echo "schemas=$schemas"; echo "created_utc=$(date -u +%FT%TZ)"; } > "$WORK/manifest.txt"
( cd "$WORK" && sha256sum production.dump.age manifest.txt row-counts.txt objects.txt scope.json content.txt owners.txt > SHA256SUMS )
rm -f "$WORK/psql" "$WORK/snapshot.id" "$WORK/snapshot-control" "$WORK/snapshot-keeper.output" "$WORK/snapshot-keeper.error"
echo "M4_BACKUP status=PASS stage=dump scope_version=$scope_version schemas=$schemas tables=$tables dump_sha256=$dump_sha encrypted_bytes=$(stat -c %s "$WORK/production.dump.age")"
