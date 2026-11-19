#!/usr/bin/env bash
# M5 CDN Phase 1 rehearsal on a SCRATCH PostgreSQL: restores a fresh copy of dpg_app + dpg_control (read through the least-privilege
# backup reader), mirrors Production ownership (objects owned by dpg_migration, executor = non-superuser with CREATEROLE +
# BYPASSRLS + membership in dpg_migration, like Supabase's postgres) and runs the generated 002 / 003 / 004 SQL.
# Output lines are counts, sizes and md5 comparisons only. Any failed invariant exits non-zero.
# Env: DATABASE_URL (reader), POSTGRES_IMAGE, OUT (dir with 002_cdn_normalization.sql and 004_tile_image_repair.sql), REPO.
set -euo pipefail
: "${DATABASE_URL:?}" "${POSTGRES_IMAGE:?}" "${OUT:?}" "${REPO:?}"
work="$(mktemp -d)"; chmod 700 "$work"
fail() { echo "M5_CDN_REHEARSAL status=FAIL reason=$1"; exit 1; }
pgp() { docker run --rm -i --network host -e DATABASE_URL "$POSTGRES_IMAGE" psql "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
sa() { docker exec -i scratch psql -U postgres -d postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
so() { docker exec -i scratch psql -U sb_owner -d postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
want() { local got; got="$(sa -c "$1")"; [ "$got" = "$2" ] || fail "$3 (got '$got', expected '$2')"; }

pgp -f - < "$REPO/scripts/backup/m5-manifest.sql" | sed -n 's/^role //p' > "$work/roles.txt"
docker run --rm -e DATABASE_URL "$POSTGRES_IMAGE" sh -c 'pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges --schema=dpg_app --schema=dpg_control' > "$work/prod.dump"
docker run -d --name scratch -e POSTGRES_PASSWORD=scratch "$POSTGRES_IMAGE" >/dev/null
for _ in $(seq 1 40); do docker exec scratch pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
for role in $(cat "$work/roles.txt"); do sa -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname = '$role') then execute format('create role %I nologin', '$role'); end if; end \$\$"; done
sa -c "create schema if not exists auth; create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid'; create or replace function auth.role() returns text language sql stable as 'select null::text'; create or replace function auth.jwt() returns jsonb language sql stable as 'select null::jsonb'"
docker cp "$work/prod.dump" scratch:/tmp/prod.dump
rc=0; docker exec scratch pg_restore -U postgres -d postgres --no-owner --no-privileges /tmp/prod.dump > "$work/restore.log" 2>&1 || rc=$?
[ "$rc" = 0 ] && ! grep -q 'pg_restore: error' "$work/restore.log" || fail "restore_failed_rc_$rc"
# Production ownership mirror: owner dpg_migration, executor sb_owner (non-superuser, BYPASSRLS, inherits dpg_migration).
sa -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname='dpg_migration') then create role dpg_migration nologin; end if; end \$\$; create role sb_owner login createrole bypassrls; grant dpg_migration to sb_owner;"
sa -c "do \$\$ declare o record; begin
  for o in select nspname from pg_namespace where nspname in ('dpg_app','dpg_control') loop execute format('alter schema %I owner to dpg_migration', o.nspname); end loop;
  for o in select n.nspname, c.relname, c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('dpg_app','dpg_control') and c.relkind in ('r','p','v','m','S') loop
    execute format('alter %s %I.%I owner to dpg_migration', case o.relkind when 'S' then 'sequence' when 'v' then 'view' when 'm' then 'materialized view' else 'table' end, o.nspname, o.relname); end loop;
  for o in select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) a from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('dpg_app','dpg_control') loop
    execute format('alter function %I.%I(%s) owner to dpg_migration', o.nspname, o.proname, o.a); end loop; end \$\$"
sa -c "grant usage on schema public to sb_owner"
sa -c "create table public.m5_snap as
  select 'products' t, id, md5(concat_ws('|', image_main_url, description, specs::text)) target, md5((to_jsonb(p) - 'image_main_url' - 'description' - 'specs' - 'version')::text) other from dpg_app.products p
  union all select 'product_images', id, md5(image_url), md5((to_jsonb(t) - 'image_url')::text) from dpg_app.product_images t
  union all select 'product_documents', id, md5(url), md5((to_jsonb(t) - 'url')::text) from dpg_app.product_documents t
  union all select 'product_descriptions', id, md5(clean_html), md5((to_jsonb(t) - 'clean_html')::text) from dpg_app.product_descriptions t
  union all select 'blog_posts', id, md5(concat_ws('|', thumbnail_url, cover_image_url)), md5((to_jsonb(t) - 'thumbnail_url' - 'cover_image_url')::text) from dpg_app.blog_posts t"
snap_now="select 'products' t, id, md5(concat_ws('|', image_main_url, description, specs::text)) target, md5((to_jsonb(p) - 'image_main_url' - 'description' - 'specs' - 'version')::text) other from dpg_app.products p
  union all select 'product_images', id, md5(image_url), md5((to_jsonb(t) - 'image_url')::text) from dpg_app.product_images t
  union all select 'product_documents', id, md5(url), md5((to_jsonb(t) - 'url')::text) from dpg_app.product_documents t
  union all select 'product_descriptions', id, md5(clean_html), md5((to_jsonb(t) - 'clean_html')::text) from dpg_app.product_descriptions t
  union all select 'blog_posts', id, md5(concat_ws('|', thumbnail_url, cover_image_url)), md5((to_jsonb(t) - 'thumbnail_url' - 'cover_image_url')::text) from dpg_app.blog_posts t"
diff_q() { echo "select count(*) filter (where n.other is distinct from s.other) other_changed, count(*) filter (where n.target is distinct from s.target) target_changed, count(*) filter (where n.id is null or s.id is null) missing from ($snap_now) n full join public.m5_snap s using (t, id) $1"; }
sizes() { sa -c "select pg_database_size(current_database()) || ' ' || coalesce((select sum(pg_total_relation_size(c.oid)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('dpg_app','dpg_control') and c.relkind='r'),0) || ' ' || pg_current_wal_lsn()"; }
old_count() { sa -c "select (select count(*) from dpg_app.product_images where starts_with(image_url,'https://cdn.dongphugia.com.vn/')) || ',' || (select count(*) from dpg_app.products where starts_with(image_main_url,'https://cdn.dongphugia.com.vn/')) || ',' || (select count(*) from dpg_app.product_documents where starts_with(url,'https://cdn.dongphugia.com.vn/')) || ',' || (select count(*) from dpg_app.product_descriptions where position('https://cdn.dongphugia.com.vn/' in clean_html)>0) || ',' || (select count(*) from dpg_app.products where position('https://cdn.dongphugia.com.vn/' in description)>0) || ',' || (select count(*) from dpg_app.products where position('https://cdn.dongphugia.com.vn/' in specs::text)>0)"; }
echo "M5_CDN_REHEARSAL old_origin_rows_before(images,main,docs,html,desc,specs)=$(old_count)"
read -r db0 rel0 lsn0 <<< "$(sizes)"

# Concurrency: an Admin edit in flight (row locks held 3 s) while 002 starts. X: name edit must survive; Y: new image must survive.
read -r X Y <<< "$(sa -c "select (select id from dpg_app.products where starts_with(image_main_url,'https://cdn.dongphugia.com.vn/') and position('https://cdn.dongphugia.com.vn/' in description)>0 order by id limit 1) || ' ' || (select id from dpg_app.products where starts_with(image_main_url,'https://cdn.dongphugia.com.vn/') order by id desc limit 1)")"
vx0="$(sa -c "select version from dpg_app.products where id=$X")"
( docker exec -i scratch psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -c "begin; update dpg_app.products set name = name || ' [edit]', version = version + 1 where id = $X; update dpg_app.products set image_main_url = 'https://other.example/edited.jpg', version = version + 1 where id = $Y; select pg_sleep(3); commit;" >/dev/null ) &
sleep 1
start=$(date +%s.%N)
so -f - < "$OUT/002_cdn_normalization.sql" > "$work/002.out" || fail "002_failed"
secs=$(echo "$(date +%s.%N) - $start" | bc)
wait
cat "$work/002.out" | sed 's/^/M5_CDN_REHEARSAL 002 /'
read -r db1 rel1 lsn1 <<< "$(sizes)"
echo "M5_CDN_REHEARSAL 002 seconds=$secs db_growth_bytes=$((db1-db0)) tables_growth_bytes=$((rel1-rel0)) wal_bytes=$(sa -c "select pg_wal_lsn_diff('$lsn1','$lsn0')::bigint") ledger_bytes=$(sa -c "select pg_total_relation_size('dpg_control.m5_cdn_ledger')") db_bytes_after=$db1"
want "select name like '% [edit]' from dpg_app.products where id=$X" t "lost_update_name"
want "select image_main_url from dpg_app.products where id=$Y" 'https://other.example/edited.jpg' "lost_update_image"
want "select version > $vx0 + 1 from dpg_app.products where id=$X" t "version_not_bumped_after_edit"
echo "M5_CDN_REHEARSAL 002 old_origin_rows_after(images,main,docs,html,desc,specs)=$(old_count)"
# Invariant: nothing outside the targeted fields changed (excluding the two edited rows); idempotent re-run.
other="$(sa -c "$(diff_q "where not (s.t = 'products' and s.id in ($X,$Y))")")"; IFS='|' read -r oc tc ms <<< "$other"
[ "$oc" = 0 ] && [ "$ms" = 0 ] || fail "non_target_data_changed(other=$oc missing=$ms)"
echo "M5_CDN_REHEARSAL 002 non_target_columns_changed=0 rows_missing=0 target_values_changed=$tc"
vsum1="$(sa -c "select sum(version) from dpg_app.products")"; led1="$(sa -c "select count(*) from dpg_control.m5_cdn_ledger")"
so -f - < "$OUT/002_cdn_normalization.sql" > /dev/null || fail "002_rerun_failed"
want "select sum(version) from dpg_app.products" "$vsum1" "rerun_not_idempotent_versions"
want "select count(*) from dpg_control.m5_cdn_ledger" "$led1" "rerun_not_idempotent_ledger"
# Rollback is exact for untouched rows and skips the edited ones.
so -f - < "$REPO/supabase/m5-production/003_cdn_normalization_rollback.sql" | sed 's/^/M5_CDN_REHEARSAL 003 /'
other="$(sa -c "$(diff_q "where not (s.t = 'products' and s.id in ($X,$Y))")")"; IFS='|' read -r oc tc ms <<< "$other"
[ "$oc" = 0 ] && [ "$ms" = 0 ] && [ "$tc" = 0 ] || fail "rollback_not_exact(other=$oc target=$tc missing=$ms)"
echo "M5_CDN_REHEARSAL 003 rollback_exact=true old_origin_rows_after(images,main,docs,html,desc,specs)=$(old_count)"
want "select image_main_url from dpg_app.products where id=$Y" 'https://other.example/edited.jpg' "rollback_overwrote_edit"
# Re-apply (002), then the targeted tile repair (004).
so -f - < "$OUT/002_cdn_normalization.sql" > /dev/null || fail "002_reapply_failed"
so -f - < "$OUT/004_tile_image_repair.sql" | sed 's/^/M5_CDN_REHEARSAL 004 /' || fail "004_failed"
so -f - < "$OUT/004_tile_image_repair.sql" > /dev/null || fail "004_rerun_failed"
echo "M5_CDN_REHEARSAL 004 tile_ledger_rows=$(sa -c "select count(*) from dpg_control.m5_tile_ledger")"
read -r db2 rel2 lsn2 <<< "$(sizes)"
echo "M5_CDN_REHEARSAL total db_growth_bytes=$((db2-db0)) db_bytes_after=$db2"
docker rm -f scratch >/dev/null
echo "M5_CDN_REHEARSAL status=PASS"
