#!/usr/bin/env bash
# DPG-42 LOCAL-ONLY performance check of the content digests (scripts/backup/m5-content.sql) on a production-shaped synthetic
# dataset: same row counts and approximate row widths as the largest Production tables measured read-only on 27/11
# (products 17,752 x ~4.8 KB, product_spec_values 135k, product_images 110k, product_descriptions 17,752 x ~2.4 KB,
# m5_cdn_ledger 138k). Runs as a reader with the Production reader settings (statement_timeout 15min, read-only) inside one
# REPEATABLE READ snapshot, then times one pg_dump of the same data. No hosted target, no live query, no tuning.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
IMG="$(sed -n "s/^  POSTGRES_IMAGE: //p" "$REPO/.github/workflows/m4-production-backup.yml")"
C="dpg42-perf-$(openssl rand -hex 4)"; trap 'docker rm -f "$C" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$C" --label dpg42.scratch=1 --network none -e POSTGRES_PASSWORD=x "$IMG" >/dev/null
for _ in $(seq 1 90); do docker logs "$C" 2>&1 | grep -q "PostgreSQL init process complete" && docker exec "$C" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
q() { docker exec -i "$C" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
q <<'SQL'
create schema dpg_app; create schema dpg_control;
create table dpg_app.products(id serial primary key, sku text, name text, body text, price numeric, updated_at timestamptz default now());
insert into dpg_app.products(sku, name, body, price) select 'SKU-' || g, 'Synthetic ' || g, repeat(md5(g::text), 150), g * 1000 from generate_series(1, 17752) g;
create table dpg_app.product_descriptions(product_id int primary key, html text);
insert into dpg_app.product_descriptions select g, repeat(md5((g*7)::text), 75) from generate_series(1, 17752) g;
create table dpg_app.product_spec_values(id serial primary key, product_id int, spec_id int, value text);
insert into dpg_app.product_spec_values(product_id, spec_id, value) select g % 17752, g % 210, repeat(md5(g::text), 7) from generate_series(1, 135311) g;
create table dpg_app.product_images(id serial primary key, product_id int, url text, alt text);
insert into dpg_app.product_images(product_id, url, alt) select g % 17752, 'https://cdn.example.invalid/' || md5(g::text) || repeat('x', 150), 'alt ' || g from generate_series(1, 110321) g;
create table dpg_control.m5_cdn_ledger(id serial primary key, path text, checksum text, at timestamptz default now());
insert into dpg_control.m5_cdn_ledger(path, checksum) select '/p/' || md5(g::text) || repeat('y', 60), md5((g*3)::text) from generate_series(1, 137980) g;
create role perf_reader login bypassrls; grant usage on schema dpg_app, dpg_control to perf_reader; grant select on all tables in schema dpg_app, dpg_control to perf_reader;
alter role perf_reader set default_transaction_read_only = on; alter role perf_reader set statement_timeout = '15min';
SQL
size="$(q -c "select pg_size_pretty(pg_database_size('postgres'))")"
start=$(date +%s.%N)
{ echo 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'; cat "$REPO/scripts/backup/m5-content.sql"; printf '\n;\nCOMMIT;\n'; } \
  | docker exec -i "$C" psql -U perf_reader -d postgres -X -q -A -t -v ON_ERROR_STOP=1 -v schemas=dpg_app,dpg_control -f - > /tmp/dpg42-perf-content.txt
digest_s=$(echo "$(date +%s.%N) - $start" | bc)
start=$(date +%s.%N); docker exec "$C" pg_dump -U perf_reader -d postgres --format=custom --compress=6 --schema=dpg_app --schema=dpg_control -f /tmp/perf.dump; dump_s=$(echo "$(date +%s.%N) - $start" | bc)
echo "DPG42_PERF database=$size tables=$(grep -c . /tmp/dpg42-perf-content.txt) content_digest_seconds=$digest_s pg_dump_seconds=$dump_s statement_timeout=15min keeper_idle_timeout=20min job_timeout=40min"
rm -f /tmp/dpg42-perf-content.txt
