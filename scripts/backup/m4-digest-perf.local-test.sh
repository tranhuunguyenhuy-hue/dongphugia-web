#!/usr/bin/env bash
# DPG-42 LOCAL-ONLY performance check of the content digests (scripts/backup/m5-content.sql) on a production-shaped synthetic
# dataset: same row counts and approximate row widths as the largest Production tables measured read-only on 27/11
# (products 17,752 x ~4.8 KB, product_spec_values 135k, product_images 110k, product_descriptions 17,752 x ~2.4 KB,
# m5_cdn_ledger 138k). Runs as a reader with the Production reader settings (statement_timeout 15min, read-only) inside one
# exported snapshot under the reader's connection limit 2 (keeper + one worker, as m4-backup-dump.sh), timing the digests and one
# pg_dump --snapshot. DPG42_PERF_SCALE=N (1-9) multiplies row counts for headroom. FAILs if the largest single statement exceeds
# 25% of statement_timeout or the snapshot hold exceeds 25% of the 20min keeper timeout. Local CPU/disk only: network latency
# and Supabase compute are not modelled. No hosted target, no live query, no tuning.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
IMG="$(sed -n "s/^  POSTGRES_IMAGE: //p" "$REPO/.github/workflows/m4-production-backup.yml")"
C="dpg42-perf-$(openssl rand -hex 4)"
docker run -d --name "$C" --label dpg42.scratch=1 --network none -e POSTGRES_PASSWORD=x "$IMG" >/dev/null
for _ in $(seq 1 90); do docker logs "$C" 2>&1 | grep -q "PostgreSQL init process complete" && docker exec "$C" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
W="$(mktemp -d)"; trap 'exec 9>&- 2>/dev/null || true; docker rm -f "$C" >/dev/null 2>&1 || true; rm -rf "$W"' EXIT
q() { docker exec -i "$C" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
SCALE="${DPG42_PERF_SCALE:-1}"; [[ "$SCALE" =~ ^[1-9]$ ]]
# Wide columns use STORAGE EXTERNAL so the synthetic text is not TOAST-compressed below the measured Production row widths.
q -v s="$SCALE" <<'SQL'
create schema dpg_app; create schema dpg_control;
create table dpg_app.products(id serial primary key, sku text, name text, body text, price numeric, updated_at timestamptz default now());
alter table dpg_app.products alter column body set storage external;
insert into dpg_app.products(sku, name, body, price) select 'SKU-' || g, 'Synthetic ' || g, repeat(md5(g::text), 150), g * 1000 from generate_series(1, 17752 * :s) g;
create table dpg_app.product_descriptions(product_id int primary key, html text);
alter table dpg_app.product_descriptions alter column html set storage external;
insert into dpg_app.product_descriptions select g, repeat(md5((g*7)::text), 75) from generate_series(1, 17752 * :s) g;
create table dpg_app.product_spec_values(id serial primary key, product_id int, spec_id int, value text);
insert into dpg_app.product_spec_values(product_id, spec_id, value) select g % 17752, g % 210, repeat(md5(g::text), 7) from generate_series(1, 135311 * :s) g;
create table dpg_app.product_images(id serial primary key, product_id int, url text, alt text);
insert into dpg_app.product_images(product_id, url, alt) select g % 17752, 'https://cdn.example.invalid/' || md5(g::text) || repeat('x', 150), 'alt ' || g from generate_series(1, 110321 * :s) g;
create table dpg_control.m5_cdn_ledger(id serial primary key, path text, checksum text, at timestamptz default now());
insert into dpg_control.m5_cdn_ledger(path, checksum) select '/p/' || md5(g::text) || repeat('y', 60), md5((g*3)::text) from generate_series(1, 137980 * :s) g;
create role perf_reader login bypassrls; grant usage on schema dpg_app, dpg_control to perf_reader; grant select on all tables in schema dpg_app, dpg_control to perf_reader; grant select on all sequences in schema dpg_app, dpg_control to perf_reader;
alter role perf_reader set default_transaction_read_only = on; alter role perf_reader set statement_timeout = '15min';
alter role perf_reader connection limit 2;
SQL
size="$(q -c "select pg_size_pretty(pg_database_size('postgres'))")"
# Same connection pattern as m4-backup-dump.sh under the reader's connection limit 2: connection 1 holds the exported snapshot
# (idle in transaction, 20min timeout) while connection 2 runs the per-table digests and then pg_dump on that snapshot.
mkfifo "$W/ctl"; exec 9<>"$W/ctl"
docker exec -i "$C" psql -U perf_reader -d postgres -X -q -A -t -v ON_ERROR_STOP=1 <&9 > "$W/snap.out" 2>&1 &
keeper=$!
printf "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL idle_in_transaction_session_timeout = '20min';\nSELECT pg_export_snapshot();\n" >&9
for _ in $(seq 1 30); do grep -qE '^[0-9A-F-]+$' "$W/snap.out" && break; sleep 0.5; done
snap="$(grep -E '^[0-9A-F-]+$' "$W/snap.out" | head -1)"; test -n "$snap"
t0=$(date +%s.%N)
{ echo 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'; echo "SET TRANSACTION SNAPSHOT '$snap';"; echo '\timing on'
  cat "$REPO/scripts/backup/m5-content.sql"; printf '\n;\nCOMMIT;\n'; } \
  | docker exec -i "$C" psql -U perf_reader -d postgres -X -q -A -t -v ON_ERROR_STOP=1 -v schemas=dpg_app,dpg_control -f - > "$W/content.txt"
t1=$(date +%s.%N)
docker exec "$C" pg_dump -U perf_reader -d postgres --format=custom --compress=6 --no-owner --snapshot="$snap" --schema=dpg_app --schema=dpg_control -f /tmp/perf.dump
t2=$(date +%s.%N)
printf 'COMMIT;\n\\q\n' >&9; exec 9>&-; wait "$keeper"
max_ms="$(grep -oE '^Time: [0-9.]+ ms' "$W/content.txt" | awk '{if ($2>m) m=$2} END {printf "%.0f", m}')"
tables="$(grep -cE '^[a-z_]+\.[a-z_0-9]+ [0-9]+ [0-9a-f]{32}$' "$W/content.txt")"
digest_s=$(echo "$t1 - $t0" | bc); dump_s=$(echo "$t2 - $t1" | bc); total_s=$(echo "$t2 - $t0" | bc)
dump_bytes="$(docker exec "$C" stat -c %s /tmp/perf.dump)"
verdict=PASS
[ "$tables" -eq 5 ] || verdict=FAIL
awk -v m="$max_ms" 'BEGIN { exit !(m < 15*60*1000/4) }' || verdict=FAIL   # largest single statement < 25% of statement_timeout
awk -v t="$total_s" 'BEGIN { exit !(t < 20*60/4) }' || verdict=FAIL       # snapshot hold < 25% of keeper idle timeout
echo "DPG42_PERF status=$verdict scale=$SCALE database=$size tables=$tables reader_connections=2 content_digest_seconds=$digest_s max_statement_ms=$max_ms pg_dump_seconds=$dump_s snapshot_held_seconds=$total_s dump_bytes=$dump_bytes budgets: statement_timeout=15min keeper_idle_timeout=20min job_timeout=40min"
[ "$verdict" = PASS ]
