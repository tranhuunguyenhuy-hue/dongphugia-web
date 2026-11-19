#!/usr/bin/env bash
# Runs 002 (generated with one excluded URL) and 003 against the synthetic fixture and asserts exact behaviour.
# Usage: PSQL="psql -h ... -U ..." scripts/m5-cdn/sql-fixture-check.sh <generated-002.sql> <003.sql>
set -euo pipefail
q() { $PSQL -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }
eq() { local got; got="$(q "$1")"; [ "$got" = "$2" ] || { echo "FIXTURE FAIL: $1 => '$got' (expected '$2')"; exit 1; }; }
$PSQL -X -q -v ON_ERROR_STOP=1 -f "$(dirname "$0")/sql-fixture.sql" >/dev/null
$PSQL -X -q -v ON_ERROR_STOP=1 -f "$1" > /dev/null
eq "select image_main_url from dpg_app.products where id=1" 'https://dpg-products.b-cdn.net/migrated/toto/A-1.JPG'
eq "select description from dpg_app.products where id=1" '<p><img src="https://dpg-products.b-cdn.net/migrated/toto/a b%20c.jpg" alt='"'x'"'><a href='"'https://dpg-products.b-cdn.net/product_docs/d.pdf'"'>d</a> https://cdn.dongphugia.com.vn.evil.example/ </p>'
eq "select specs->'docs'->0->>'url' from dpg_app.products where id=1" 'https://dpg-products.b-cdn.net/documents/toto/x.pdf'
eq "select specs->>'k' from dpg_app.products where id=1" 'https://cdn.dongphugia.com.vnx/'
eq "select image_url from dpg_app.product_images where id=2" 'https://dpg-products.b-cdn.net/products//ckfinder/B%E1%BB%93n.png'
eq "select image_main_url from dpg_app.products where id=2" 'https://cdn.dongphugia.com.vn/products/gach-op-lat/36GP0880.jpg'
eq "select image_url from dpg_app.product_images where id=4" 'https://cdn.dongphugia.com.vn/products/gach-op-lat/36GP0880.jpg'
eq "select concat(image_main_url, description) from dpg_app.products where id=3" 'http://cdn.dongphugia.com.vn/x.jpg<img src="https://CDN.dongphugia.com.vn/y.jpg">'
eq "select count(*) from dpg_app.products where id in (4,5,6) and description like '%https://cdn.dongphugia.com.vn/%'" 3
eq "select clean_html from dpg_app.product_descriptions where id=1" '<img src="https://dpg-products.b-cdn.net/description_assets/q.png">'
eq "select url from dpg_app.product_documents where id=1" 'https://dpg-products.b-cdn.net/product_docs/d.pdf'
eq "select count(*) from dpg_app.blog_posts where thumbnail_url like 'https://cdn.dongphugia.com.vn/%' and content like '%https://cdn.dongphugia.com.vn/%'" 1
eq "select string_agg(id || ':' || version, ',' order by id) from dpg_app.products where id <= 9" '1:2,2:1,3:1,4:1,5:1,6:1,7:2,8:1,9:2'
eq "select count(*) from dpg_app.products where updated_at <> '2026-01-01'" 0
eq "select count(*) from dpg_control.m5_cdn_ledger" 9
# Idempotent re-run: nothing more to do.
$PSQL -X -q -v ON_ERROR_STOP=1 -f "$1" > /dev/null
eq "select string_agg(id || ':' || version, ',' order by id) from dpg_app.products where id <= 9" '1:2,2:1,3:1,4:1,5:1,6:1,7:2,8:1,9:2'
# An Admin edit after the migration must survive the rollback.
q "update dpg_app.product_images set image_url = 'https://dpg-products.b-cdn.net/hita/new-upload.png' where id = 6"
$PSQL -X -q -v ON_ERROR_STOP=1 -f "$2" > /dev/null
eq "select image_url from dpg_app.product_images where id=6" 'https://dpg-products.b-cdn.net/hita/new-upload.png'
eq "select count(*) from dpg_control.m5_cdn_ledger where rolled_back_at is null" 1
eq "select count(*) from (select 'p' k, id, md5(concat_ws('|', image_main_url, description, specs::text)) h from dpg_app.products union all select 'i', id, md5(image_url) from dpg_app.product_images union all select 'd', id, md5(url) from dpg_app.product_documents union all select 's', id, md5(clean_html) from dpg_app.product_descriptions union all select 'b', id, md5(concat_ws('|', thumbnail_url, cover_image_url, content)) from dpg_app.blog_posts) now full join snapshot s using (k, id) where now.h is distinct from s.h" 1
eq "select string_agg(id || ':' || version, ',' order by id) from dpg_app.products where id <= 9" '1:3,2:1,3:1,4:1,5:1,6:1,7:3,8:1,9:2'
if [ -n "${3:-}" ]; then
  $PSQL -X -q -v ON_ERROR_STOP=1 -f "$3" > /dev/null
  eq "select image_url from dpg_app.product_images where id=4" 'https://dpg-products.b-cdn.net/products/gach-op-lat/36GP0880.original.jpg'
  eq "select image_main_url || ' ' || version from dpg_app.products where id=2" 'https://dpg-products.b-cdn.net/products/gach-op-lat/36GP0880.original.jpg 2'
  eq "select count(*) from dpg_control.m5_tile_ledger" 2
  $PSQL -X -q -v ON_ERROR_STOP=1 -f "$3" > /dev/null   # re-run is a no-op
  eq "select version from dpg_app.products where id=2" 2
fi
echo "M5_CDN_FIXTURE PASS"
