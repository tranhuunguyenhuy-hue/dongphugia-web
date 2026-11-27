#!/usr/bin/env bash
# DPG-42 LOCAL-ONLY proof for the Production backup lane (never a hosted project, never a real artifact or secret).
# Builds a synthetic Production-shaped database (reviewed #470 fixture + canonical price columns + the real commerce schema,
# synthetic orders/quotes only), then runs the REAL lane scripts end to end with a throwaway age key:
# scope preflight -> consistent snapshot dump -> encrypted bundle -> scratch restore + gate -> reader least-privilege proof,
# plus a historical v1 bundle and fail-closed negative cases. Usage: bash scripts/backup/m4-commerce-coverage.local-test.sh
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; export REPO
POSTGRES_IMAGE="$(sed -n "s/^  POSTGRES_IMAGE: //p" "$REPO/.github/workflows/m4-production-backup.yml")"; export POSTGRES_IMAGE
test -n "$POSTGRES_IMAGE"
T="$(mktemp -d /tmp/dpg42-local.XXXXXX)"; chmod 700 "$T"
SRC=dpg42-src; PORT=55432; PW="$(openssl rand -hex 16)"; RPW="$(openssl rand -hex 16)"
pass=0; fail=0; results=()
ok() { pass=$((pass+1)); results+=("PASS $1"); echo "PASS $1"; }
bad() { fail=$((fail+1)); results+=("FAIL $1"); echo "FAIL $1"; }
cleanup() { docker rm -f "$SRC" scratch dpg42-neg >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT
src() { docker exec -i "$SRC" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
op() { docker exec -i "$SRC" psql -U dpg_operator -d postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }

age-keygen -o "$T/key.txt" 2>/dev/null; AGE_RECIPIENT="$(age-keygen -y "$T/key.txt")"; AGE_IDENTITY="$(cat "$T/key.txt")"; export AGE_RECIPIENT AGE_IDENTITY
docker rm -f "$SRC" >/dev/null 2>&1 || true
docker run -d --name "$SRC" --network host -e PGPORT=$PORT -e POSTGRES_PASSWORD="$PW" "$POSTGRES_IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$SRC" pg_isready -U postgres -p $PORT >/dev/null 2>&1 && break; sleep 1; done
export PGPORT=$PORT
src() { docker exec -i -e PGPORT=$PORT "$SRC" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
op() { docker exec -i -e PGPORT=$PORT "$SRC" psql -U dpg_operator -d postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }

# ---- synthetic Production-shaped source (no customer data) ----
P470="$REPO/supabase/prod-prep/470"; CM="$REPO/supabase/commerce-v1"
src -f - < "$P470/tests/fixture.sql"; src -f - < "$P470/tests/seed.sql"; src -f - < "$P470/tests/seed-scope.sql"
src -c "alter role dpg_operator createrole; grant create on database postgres to dpg_operator"
op -v approved_sha=local -f - < "$P470/001_canonical_price_columns.sql" >/dev/null
op -v approved_sha=local -f - < "$P470/002_canonical_price_grants.sql" >/dev/null
op -v approved_sha=local -v target=production -v admin_role=dpg_admin_api -f - < "$CM/001_commerce_schema.sql" >/dev/null
src <<'SQL'
update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=1000000, canonical_price_checked_at=now() where sku='VS-OK';
update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=2000000, promotional_price_vnd=1800000, online_voucher_amount_vnd=100000, canonical_price_checked_at=now() where sku='VS-PROMO';
set role dpg_migration;
create table dpg_app.banners(id serial primary key, title text not null, is_active bool not null default true);
insert into dpg_app.banners(title) values ('synthetic banner');
reset role;
insert into dpg_app.products(sku,name,slug,category_id,brand_id,price_state,stock_status)
  select 'SYN-' || g, 'Synthetic product ' || g, 'syn-' || g, 5, 1, 'unknown', 'in_stock' from generate_series(1, 17000) g;
SQL
order() { src -c "set role dpg_commerce_intake; select dpg_commerce.order_submit(jsonb_build_object('customerName','Khach Tong Hop','customerPhone','09' || lpad(($1)::text, 8, '0'),'deliveryAddress','1 Duong Tong Hop, Q1','items',jsonb_build_array(jsonb_build_object('productId',1,'quantity',1),jsonb_build_object('productId',2,'quantity',2)),'expectedTotalVnd',4400000), 'syn-order-$1', md5('ip$1')) ->> 'code'"; }
for i in 1 2 3; do order "1000000$i" >/dev/null; done
src -c "set role dpg_commerce_intake; select dpg_commerce.quote_submit('{\"customerName\":\"Khach Bao Gia\",\"customerPhone\":\"0912000001\",\"items\":[{\"productId\":3,\"quantity\":4}],\"note\":\"tong hop\"}', 'syn-quote-1', md5('q1')) ->> 'code'" >/dev/null
test "$(src -c "select count(*) from dpg_commerce.orders")" = 3 && ok "S0 synthetic source: 3 schemas, 3 orders + 1 quote via real SECURITY DEFINER intake, 17k synthetic products" || bad S0

# ---- reader exactly as Production 001 + reviewed 002 (operator = non-superuser stand-in for postgres) ----
sed -e "s/<OWNER_GENERATED_STRONG_PASSWORD>/$RPW/" -e 's/for role postgres in schema/for role dpg_operator in schema/' "$REPO/supabase/m5-production/001_backup_reader_role.sql" | op -f - >/dev/null
DBURL="postgres://dpg_backup_reader:$RPW@127.0.0.1:$PORT/postgres?sslmode=disable"
pre() { DATABASE_URL="$DBURL" bash "$REPO/scripts/backup/m4-scope-preflight.sh" > "$T/pre.log" 2>&1; }
if pre; then bad "N1 preflight must fail before the 002 grant"; else grep -q 'reason=reader_missing_schema_usage' "$T/pre.log" && ok "N1 preflight FAILS closed without the commerce grant (reader_missing_schema_usage)" || { cat "$T/pre.log"; bad N1; }; fi
op -f - < "$REPO/supabase/m5-production/002_backup_reader_commerce_scope.sql" > "$T/g.txt"
IFS='|' read -r u ro rel rd w sm ex mem da < "$T/g.txt"
[ "$u|$ro|$w|$sm|$ex|$mem|$da" = "t|t|0|0|0|0|2" ] && [ "$rel" = "$rd" ] && ok "G1 002 grant: usage, read-only, $rd/$rel readable, 0 DML, 0 sequence USAGE/UPDATE, 0 EXECUTE, 0 memberships, 2 default ACL" || { cat "$T/g.txt"; bad G1; }
if op -f - < "$REPO/supabase/m5-production/002_backup_reader_commerce_scope.sql" >/dev/null 2>&1; then bad "G2 002 must refuse a second run"; else ok "G2 002 refuses a non-baseline reader state (re-run)"; fi
test "$(src -c "select count(*) from pg_auth_members where roleid='dpg_commerce_owner'::regrole and member='dpg_operator'::regrole and (set_option or inherit_option)")" = 0 && ok "G3 operator keeps no SET/INHERIT membership in dpg_commerce_owner after 002" || bad G3
pre && grep -q 'M4_SCOPE status=PASS' "$T/pre.log" && ok "P1 preflight PASS: discovery covered, reader reads whole scope, no write path" || { cat "$T/pre.log"; bad P1; }

# ---- positive v2 bundle with concurrent commits during the dump ----
( for i in $(seq 10 40); do order "20000$i" >/dev/null 2>&1 || true; sleep 0.15; done ) & writer=$!
sleep 0.3
if DATABASE_URL="$DBURL" WORK="$T/b2" bash "$REPO/scripts/backup/m4-backup-dump.sh" > "$T/dump.log" 2>&1; then ok "B1 $(grep -o 'status=PASS.*' "$T/dump.log" | cut -c1-120)"; else cat "$T/dump.log"; bad B1; fi
wait $writer
bundle_orders="$(sed -n 's/^dpg_commerce.orders //p' "$T/b2/row-counts.txt")"; final_orders="$(src -c "select count(*) from dpg_commerce.orders")"
[ -n "$bundle_orders" ] && [ "$final_orders" -gt "$bundle_orders" ] && ok "B2 writes were not blocked: $final_orders orders now, snapshot captured $bundle_orders" || bad "B2 concurrency (bundle=$bundle_orders final=$final_orders)"
grep -q "$PW\|$RPW" "$T/dump.log" "$T/b2/manifest.txt" "$T/b2/objects.txt" "$T/b2/content.txt" && bad "B3 secret leaked" || ok "B3 no password in logs or bundle text files"
grep -qi 'Khach Tong Hop\|09100000' "$T/b2/"*.txt "$T/dump.log" && bad "B4 row data leaked" || ok "B4 no row data (names/phones) in manifest, counts, content or log"
ls "$T/b2" | grep -qx production.dump && bad "B5 plaintext dump left" || ok "B5 plaintext dump shredded; only production.dump.age"
cp -r "$T/b2" "$T/b2-pristine"

restore() { BUNDLE="$1" CONTAINER=scratch bash "$REPO/scripts/backup/m4-restore-rehearsal.sh" > "$2" 2>&1; }
if restore "$T/b2" "$T/r2.log"; then ok "R1 $(grep -o 'M4_RESTORE status=PASS.*' "$T/r2.log")"; else cat "$T/r2.log"; bad R1; fi
grep -q 'coverage=full' "$T/r2.log" && grep -q 'gate=PASS scope_version=2' "$T/r2.log" && ok "R2 v2 bundle reports coverage=full and gate PASS (counts, content, objects/ACL, owners)" || bad R2
rs() { docker exec -i scratch psql -U postgres -d owned -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
[ "$(rs -c "select count(*) from dpg_commerce.orders")" = "$bundle_orders" ] && ok "R3 restored dpg_commerce.orders = snapshot count ($bundle_orders)" || bad R3
[ "$(rs -c "select pg_get_userbyid(proowner) || ':' || prosecdef from pg_proc where oid = 'dpg_commerce.order_submit(jsonb,text,text)'::regprocedure")" = 'dpg_commerce_owner:true' ] && ok "R4 SECURITY DEFINER order_submit restored owned by dpg_commerce_owner" || bad R4
[ "$(rs -c "select has_function_privilege('dpg_commerce_intake','dpg_commerce.order_submit(jsonb,text,text)','EXECUTE')::text || has_function_privilege('dpg_commerce_intake','dpg_commerce.status_guard()','EXECUTE')::text || has_schema_privilege('dpg_commerce_intake','dpg_app','USAGE')::text")" = 'truefalsefalse' ] && ok "R5 restored effective privileges: intake EXECUTE order_submit only, no dpg_app usage" || bad R5
maxid="$(rs -c "select max(id) from dpg_commerce.orders")"
newcode="$(rs -c "set role dpg_commerce_intake; select dpg_commerce.order_submit(jsonb_build_object('customerName','Khach Tong Hop','customerPhone','0939999999','deliveryAddress','1 Duong Tong Hop, Q1','items',jsonb_build_array(jsonb_build_object('productId',1,'quantity',1)),'expectedTotalVnd',1000000), 'post-restore-1', md5('pr')) ->> 'code'")"
[ -n "$newcode" ] && [ "$(rs -c "select id from dpg_commerce.orders where code = '$newcode'")" -gt "$maxid" ] && ok "R6 restored SECURITY DEFINER intake works and sequence state continues after max id ($maxid)" || bad R6
if rs -c "set role dpg_commerce_intake; select count(*) from dpg_commerce.orders" >/dev/null 2>&1; then bad "R7 intake direct read"; else ok "R7 restored intake role still cannot read tables directly"; fi
if rs -c "update dpg_commerce.order_lines set quantity = quantity" >/dev/null 2>&1; then bad "R8 append-only trigger"; else ok "R8 restored append-only trigger still blocks order_lines updates"; fi
if REPO="$REPO" CONTAINER=scratch bash "$REPO/scripts/backup/m4-reader-proof.sh" > "$T/proof.log" 2>&1; then ok "L1 reader proof PASS: $(grep -c DENIED "$T/proof.log") write/nextval/setval/secdef attempts DENIED, dump of whole scope, BYPASSRLS required"; else cat "$T/proof.log"; bad L1; fi

# ---- historical v1 bundle produced exactly like current main (2 schemas, no scope.json) ----
v1="$T/b1"; mkdir -p "$v1"; chmod 700 "$v1"
git -C "$REPO" show origin/main:scripts/backup/m5-manifest.sql > "$T/m5-manifest-main.sql"
pgr() { docker run --rm -i --network host -e DATABASE_URL="$DBURL" "$POSTGRES_IMAGE" psql "$DBURL" -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
pgr -c "select format('select %L || '' '' || count(*) from %I.%I;', schemaname || '.' || tablename, schemaname, tablename) from pg_tables where schemaname in ('dpg_app','dpg_control') order by 1" | pgr -f - | sort > "$v1/row-counts.txt"
pgr -f - < "$T/m5-manifest-main.sql" > "$v1/objects.txt"
pgr -f - < "$REPO/scripts/backup/m5-manifest.sql" > "$T/objects-new-default.txt"
cmp -s "$v1/objects.txt" "$T/objects-new-default.txt" && ok "C1 new m5-manifest.sql with no variables is byte-identical to main (existing callers unchanged)" || bad C1
docker run --rm --network host "$POSTGRES_IMAGE" pg_dump "$DBURL" --format=custom --compress=6 --no-owner --schema=dpg_app --schema=dpg_control > "$v1/production.dump"
sha="$(sha256sum "$v1/production.dump" | cut -d' ' -f1)"; age -r "$AGE_RECIPIENT" -o "$v1/production.dump.age" "$v1/production.dump"; rm -f "$v1/production.dump"
printf 'backup_id=m4-local-v1\nplaintext_dump_sha256=%s\ntables=%s\n' "$sha" "$(wc -l < "$v1/row-counts.txt")" > "$v1/manifest.txt"
( cd "$v1" && sha256sum production.dump.age manifest.txt row-counts.txt objects.txt > SHA256SUMS )
if restore "$v1" "$T/r1.log"; then ok "C2 historical v1 bundle still restores: $(grep -o 'gate=PASS.*' "$T/r1.log")"; else cat "$T/r1.log"; bad C2; fi
grep -q 'coverage=limited' "$T/r1.log" && grep -q 'dpg_commerce_NOT_covered' "$T/r1.log" && ! grep -q 'coverage=full' "$T/r1.log" && ok "C3 v1 bundle honestly reported coverage=limited, dpg_commerce NOT covered" || bad C3
[ "$(docker exec scratch psql -U postgres -At -c "select to_regnamespace('dpg_commerce') is null")" = t ] && ok "C4 v1 restore contains no dpg_commerce (no silent full-recovery claim)" || bad C4

# ---- negative bundle cases (each must end without status=PASS) ----
neg() { local name="$1" mutate="$2" expect="$3"; rm -rf "$T/n"; cp -r "$T/b2-pristine" "$T/n"; ( cd "$T/n" && eval "$mutate" )
  if restore "$T/n" "$T/n.log"; then bad "$name (restore passed)"; elif grep -q 'M4_RESTORE status=PASS' "$T/n.log"; then bad "$name (PASS printed)"; elif grep -q "$expect" "$T/n.log"; then ok "$name -> $expect"; else tail -3 "$T/n.log"; bad "$name (unexpected reason)"; fi; }
resum() { sha256sum $(awk '{print $2}' SHA256SUMS) > SHA256SUMS; }
neg "N2 tampered scope.json (schemas narrowed) with recomputed checksum" "sed -i 's/,\"dpg_commerce\"//' scope.json; resum" 'scope_schemas_not_reviewed'
neg "N3 unknown scope version" "sed -i 's/\"version\":2/\"version\":9/' scope.json; resum" 'scope_version_unknown'
neg "N4 malformed scope.json" "echo '{' > scope.json; resum" 'scope_json_invalid'
neg "N5 checksum mismatch (content.txt edited, sums not updated)" "sed -i '1s/ [0-9a-f]*\$/ 00000000000000000000000000000000/' content.txt" 'checksum_mismatch'
neg "N6 missing archive" "rm -f production.dump.age" 'checksum_mismatch'
neg "N7 corrupt archive with recomputed checksum" "head -c 2000 /dev/urandom > production.dump.age; resum" 'decrypt_failed'
neg "N8 scope.json present but unlisted in SHA256SUMS" "sed -i '/scope.json/d' SHA256SUMS" 'unlisted_file'
neg "N9 v2 bundle missing content.txt" "rm -f content.txt; sed -i '/content.txt/d' SHA256SUMS" 'v2_file_missing'
neg "N10 row-count mismatch" "sed -i 's/^dpg_commerce.orders [0-9]*/dpg_commerce.orders 999/' row-counts.txt; resum" 'row_counts_differ'
neg "N11 content digest mismatch" "sed -i '/^dpg_commerce.orders /s/ [0-9a-f]\\{32\\}\$/ ffffffffffffffffffffffffffffffff/' content.txt; resum" 'content_differs'
neg "N12 object/definition mismatch" "sed -i '/^defs functions dpg_commerce /d' objects.txt; resum" 'manifest_differs'
neg "N13 ownership mismatch" "sed -i 's/^owner function dpg_commerce_owner secdef dpg_commerce.order_submit/owner function dpg_migration secdef dpg_commerce.order_submit/' owners.txt; resum" 'owners_differ'
neg "N14 truncated archive re-encrypted with a matching manifest sha (restore error)" "age -d -i '$T/key.txt' production.dump.age > p.dump; head -c \$((\$(stat -c %s p.dump)/2)) p.dump > t.dump; sed -i \"s/^plaintext_dump_sha256=.*/plaintext_dump_sha256=\$(sha256sum t.dump | cut -d' ' -f1)/\" manifest.txt; age -r '$AGE_RECIPIENT' -o production.dump.age t.dump; rm -f p.dump t.dump; resum" 'archive_unreadable\|pg_restore_exit\|pg_restore_errors\|ownership_restore_failed'

# ---- negative preflight cases on the source (restored after each) ----
npre() { local name="$1" setup="$2" undo="$3" expect="$4"; src -c "$setup" >/dev/null
  if pre; then bad "$name (preflight passed)"; elif grep -q "$expect" "$T/pre.log"; then ok "$name -> $expect"; else cat "$T/pre.log"; bad "$name"; fi; src -c "$undo" >/dev/null; }
npre "N15 uncovered dpg_* schema with tables (future dpg_core)" "create schema dpg_core; create table dpg_core.t(id int)" "drop schema dpg_core cascade" 'uncovered_schema'
npre "N16 missing sequence SELECT" "revoke select on sequence dpg_commerce.events_id_seq from dpg_backup_reader" "grant select on sequence dpg_commerce.events_id_seq to dpg_backup_reader" 'reader_missing_sequence_select'
npre "N17 reader gains DML" "grant insert on dpg_commerce.events to dpg_backup_reader" "revoke insert on dpg_commerce.events from dpg_backup_reader" 'reader_has_write_privileges'
npre "N18 reader gains sequence USAGE" "grant usage on sequence dpg_commerce.orders_id_seq to dpg_backup_reader" "revoke usage on sequence dpg_commerce.orders_id_seq from dpg_backup_reader" 'reader_can_mutate_sequences'
npre "N19 reader gains EXECUTE on a SECURITY DEFINER entry point" "grant execute on function dpg_commerce.order_submit(jsonb,text,text) to dpg_backup_reader" "revoke execute on function dpg_commerce.order_submit(jsonb,text,text) from dpg_backup_reader" 'reader_can_execute_security_definer'
src -c "set role dpg_commerce_owner; create table dpg_commerce.future_probe(id int)" >/dev/null && pre && ok "D1 default ACL: a new dpg_commerce table is readable by the reader automatically" || { cat "$T/pre.log"; bad D1; }
src -c "drop table dpg_commerce.future_probe" >/dev/null
src -c "alter default privileges for role dpg_commerce_owner in schema dpg_commerce revoke select on tables from dpg_backup_reader; set role dpg_commerce_owner; create table dpg_commerce.future_probe2(id int)" >/dev/null
if pre; then bad "N20 missing default ACL not detected"; else grep -q 'reader_missing_table_select' "$T/pre.log" && ok "N20 missing default ACL -> new table unreadable -> preflight FAIL" || bad N20; fi
src -c "drop table dpg_commerce.future_probe2; alter default privileges for role dpg_commerce_owner in schema dpg_commerce grant select on tables to dpg_backup_reader" >/dev/null
# dump must fail closed when the reader cannot read the scope (no partial bundle)
op -f - < "$REPO/supabase/m5-production/002_backup_reader_commerce_scope_rollback.sql" > "$T/rb.txt"
[ "$(tr -d '\n' < "$T/rb.txt")" = 'f|0|0' ] && ok "G4 rollback restores the exact baseline (no usage, no relation ACL, no default ACL)" || { cat "$T/rb.txt"; bad G4; }
if DATABASE_URL="$DBURL" WORK="$T/bf" bash "$REPO/scripts/backup/m4-backup-dump.sh" > "$T/df.log" 2>&1; then bad "N21 dump without grant must fail"; else grep -q 'status=PASS' "$T/df.log" && bad "N21 PASS printed" || ok "N21 dump without the commerce grant fails closed (no bundle, no PASS)"; fi

echo "----"; printf '%s\n' "${results[@]}" > "${DPG42_RESULTS:-/dev/null}"
echo "DPG42 local proof: $pass PASS, $fail FAIL"
test "$fail" = 0
