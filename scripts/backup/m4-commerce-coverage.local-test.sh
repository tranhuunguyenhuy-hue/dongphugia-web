#!/usr/bin/env bash
# DPG-42 LOCAL-ONLY proof for the Production backup lane (never a hosted project, never a real artifact or secret).
# Builds a synthetic Production-shaped database (reviewed #470 fixture + canonical price columns + the real commerce schema
# + a Supabase-style auth.uid() policy dependency; synthetic orders/quotes only), then runs the REAL lane scripts end to end
# with a throwaway age key on a private Docker network with uniquely named, labelled containers:
# scope preflight -> consistent snapshot dump -> encrypted bundle -> ownership-preserving scratch restore + gate -> reader
# least-privilege proof, plus a historical v1 bundle (built with the pinned base revision) and fail-closed negative cases.
# Usage: bash scripts/backup/m4-commerce-coverage.local-test.sh   (optional DPG42_RESULTS=<file>)
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; export REPO
V1_BASE="${V1_BASE:-d1c9d8e3d540a233a53c852119c909578b96f525}"
POSTGRES_IMAGE="$(sed -n "s/^  POSTGRES_IMAGE: //p" "$REPO/.github/workflows/m4-production-backup.yml")"; export POSTGRES_IMAGE
test -n "$POSTGRES_IMAGE"
ID="$(openssl rand -hex 4)"; T="$(mktemp -d /tmp/dpg42-local.XXXXXX)"; chmod 700 "$T"
SRC="dpg42-src-$ID"; NET="dpg42-net-$ID"; SCR="dpg42-scratch-$ID"; export CONTAINER="$SCR" DOCKER_NETWORK="$NET"
PW="$(openssl rand -hex 16)"; RPW="$(openssl rand -hex 16)"; OPW="$(openssl rand -hex 16)"; SHA40="$(printf 'f%.0s' $(seq 1 40))"
pass=0; fail=0; results=()
ok() { pass=$((pass+1)); results+=("PASS $1"); echo "PASS $1"; }
bad() { fail=$((fail+1)); results+=("FAIL $1"); echo "FAIL $1"; }
cleanup() { docker rm -f "$SRC" "$SCR" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT
docker network create --internal --label dpg42.scratch=1 "$NET" >/dev/null
docker run -d --name "$SRC" --label dpg42.scratch=1 --network "$NET" -e POSTGRES_PASSWORD="$PW" "$POSTGRES_IMAGE" >/dev/null
for _ in $(seq 1 90); do docker logs "$SRC" 2>&1 | grep -q "PostgreSQL init process complete" && docker exec "$SRC" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
src() { docker exec -i "$SRC" psql -U postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
op() { docker exec -i "$SRC" psql -U dpg_operator -d postgres -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
g002() { op -v target_ref=bonxyxluzlxfkdetryoo -v approved_sha="$SHA40" -f - < "$REPO/supabase/m5-production/002_backup_reader_commerce_scope$1.sql"; }
age-keygen -o "$T/key.txt" 2>/dev/null; AGE_RECIPIENT="$(age-keygen -y "$T/key.txt")"; AGE_IDENTITY="$(cat "$T/key.txt")"; export AGE_RECIPIENT AGE_IDENTITY

# ---- synthetic Production-shaped source (no customer data) ----
P470="$REPO/supabase/prod-prep/470"; CM="$REPO/supabase/commerce-v1"
src -f - < "$REPO/scripts/backup/scratch-platform-prereqs.sql" >/dev/null      # Supabase provides auth.* in the real project
src -c "grant usage on schema auth to public" >/dev/null                         # Supabase grants auth usage to its roles
src -f - < "$P470/tests/fixture.sql" >/dev/null; src -f - < "$P470/tests/seed.sql" >/dev/null; src -f - < "$P470/tests/seed-scope.sql" >/dev/null
src -c "alter role dpg_operator createrole password '$OPW'; grant create on database postgres to dpg_operator" >/dev/null
op -v approved_sha=local -f - < "$P470/001_canonical_price_columns.sql" >/dev/null 2>&1
op -v approved_sha=local -f - < "$P470/002_canonical_price_grants.sql" >/dev/null 2>&1
op -v approved_sha=local -v target=production -v admin_role=dpg_admin_api -f - < "$CM/001_commerce_schema.sql" >/dev/null 2>&1
src >/dev/null <<'SQL'
update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=1000000, canonical_price_checked_at=now() where sku='VS-OK';
update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=2000000, promotional_price_vnd=1800000, online_voucher_amount_vnd=100000, canonical_price_checked_at=now() where sku='VS-PROMO';
set role dpg_migration;
create table dpg_app.banners(id serial primary key, title text not null, is_active bool not null default true);
insert into dpg_app.banners(title) values ('synthetic banner');
create table dpg_app.owner_notes(id serial primary key, owner_id uuid, note text);
alter table dpg_app.owner_notes enable row level security; alter table dpg_app.owner_notes force row level security;
create policy owner_notes_own on dpg_app.owner_notes for select to authenticated using (owner_id = auth.uid());
grant select on dpg_app.owner_notes to authenticated;
reset role;
insert into dpg_app.products(sku,name,slug,category_id,brand_id,price_state,stock_status)
  select 'SYN-' || g, 'Synthetic product ' || g, 'syn-' || g, 5, 1, 'unknown', 'in_stock' from generate_series(1, 17000) g;
SQL
order() { src -c "set role dpg_commerce_intake; select dpg_commerce.order_submit(jsonb_build_object('customerName','Khach Tong Hop','customerPhone','09' || lpad(($1)::text, 8, '0'),'deliveryAddress','1 Duong Tong Hop, Q1','items',jsonb_build_array(jsonb_build_object('productId',1,'quantity',1),jsonb_build_object('productId',2,'quantity',2)),'expectedTotalVnd',4400000), 'syn-order-$1', md5('ip$1')) ->> 'code'"; }
for i in 1 2 3; do order "1000000$i" >/dev/null; done
src -c "set role dpg_commerce_intake; select dpg_commerce.quote_submit('{\"customerName\":\"Khach Bao Gia\",\"customerPhone\":\"0912000001\",\"items\":[{\"productId\":3,\"quantity\":4}],\"note\":\"tong hop\"}', 'syn-quote-1', md5('q1')) ->> 'code'" >/dev/null
test "$(src -c "select count(*) from dpg_commerce.orders")" = 3 && ok "S0 synthetic source: 3 schemas, auth.uid() policy dependency, 3 orders + 1 quote via real SECURITY DEFINER intake, 17k synthetic products" || bad S0

# ---- reader exactly as Production 001 + reviewed 002 (operator = non-superuser stand-in for postgres) ----
sed -e "s/<OWNER_GENERATED_STRONG_PASSWORD>/$RPW/" -e 's/for role postgres in schema/for role dpg_operator in schema/' "$REPO/supabase/m5-production/001_backup_reader_role.sql" | op -f - >/dev/null
DBURL="postgres://dpg_backup_reader:$RPW@$SRC:5432/postgres?sslmode=disable"; OPURL="postgres://dpg_operator:$OPW@$SRC:5432/postgres?sslmode=disable"
pre() { DATABASE_URL="${1:-$DBURL}" bash "$REPO/scripts/backup/m4-scope-preflight.sh" > "$T/pre.log" 2>&1; }
if pre; then bad "N1 preflight must fail before the 002 grant"; else grep -q 'reason=reader_missing_schema_usage' "$T/pre.log" && ok "N1 preflight FAILS closed without the commerce grant" || { cat "$T/pre.log"; bad N1; }; fi
if op -f - < "$REPO/supabase/m5-production/002_backup_reader_commerce_scope.sql" >/dev/null 2>&1; then bad "G0 002 must refuse without target_ref"; else ok "G0 002 refuses to run without -v target_ref/approved_sha"; fi
if op -v target_ref=uybumsnyqpwcidjxmfsv -v approved_sha="$SHA40" -f - < "$REPO/supabase/m5-production/002_backup_reader_commerce_scope.sql" > "$T/g.txt" 2>&1; then bad "G0b wrong target_ref"; else grep -q 'DPG42_GUARD: target_ref' "$T/g.txt" && ok "G0b 002 refuses a wrong target_ref (TEST ref)" || bad G0b; fi
src -c "select 1" >/dev/null
mem_before="$(src -c "select string_agg(roleid::regrole || '>' || member::regrole || ':' || grantor::regrole || ':' || admin_option || inherit_option || set_option, ',' order by 1) from pg_auth_members where member in ('dpg_operator'::regrole, 'dpg_backup_reader'::regrole)")"
g002 "" > "$T/g.txt" 2>&1 && grep -q '^DPG42_GRANT_VERIFIED target_ref=bonxyxluzlxfkdetryoo' "$T/g.txt" && ok "G1 002 applied; in-transaction post-conditions verified (exact reader ACL, no write/column/function/CREATE path, other ACLs + memberships unchanged)" || { cat "$T/g.txt"; bad G1; }
mem_after="$(src -c "select string_agg(roleid::regrole || '>' || member::regrole || ':' || grantor::regrole || ':' || admin_option || inherit_option || set_option, ',' order by 1) from pg_auth_members where member in ('dpg_operator'::regrole, 'dpg_backup_reader'::regrole)")"
[ "$mem_before" = "$mem_after" ] && ok "G2 operator/reader memberships identical before and after 002 ($mem_after)" || bad "G2 ($mem_before vs $mem_after)"
if g002 "" >/dev/null 2>&1; then bad "G3 002 must refuse a second run"; else ok "G3 002 refuses a non-baseline reader state (re-run)"; fi
pre && grep -q 'M4_SCOPE status=PASS' "$T/pre.log" && ok "P1 preflight PASS as dpg_backup_reader: scope covered, whole scope readable, no write/escalation path" || { cat "$T/pre.log"; bad P1; }

# ---- positive v2 bundle; a writer commits WHILE the exported snapshot is held (synchronized on the keeper session) ----
( for _ in $(seq 1 400); do
    if [ "$(src -c "select count(*) from pg_stat_activity where usename='dpg_backup_reader' and state like 'idle in transaction%'")" -ge 1 ]; then
      code="$(order 3000000001)"; held="$(src -c "select count(*) from pg_stat_activity where usename='dpg_backup_reader' and state like 'idle in transaction%'")"
      echo "$code $held" > "$T/writer.txt"; exit 0; fi; sleep 0.02; done ) & writer=$!
if DATABASE_URL="$DBURL" WORK="$T/b2" timeout 600 bash "$REPO/scripts/backup/m4-backup-dump.sh" > "$T/dump.log" 2>&1; then ok "B1 $(grep -o 'status=PASS.*' "$T/dump.log" | cut -c1-110)"; else cat "$T/dump.log"; bad B1; fi
wait $writer || true
read -r wcode wheld < "$T/writer.txt" 2>/dev/null || { wcode=''; wheld=0; }
bundle_orders="$(sed -n 's/^dpg_commerce.orders //p' "$T/b2/row-counts.txt")"
[ -n "$wcode" ] && [ "$wheld" -ge 1 ] && [ "$(src -c "select count(*) from dpg_commerce.orders where code='$wcode'")" = 1 ] && [ "$bundle_orders" = 3 ] \
  && ok "B2 order $wcode committed while the snapshot keeper was still open (writes not blocked); snapshot holds the pre-commit 3 orders" || bad "B2 synchronized concurrency (code=$wcode held=$wheld bundle=$bundle_orders)"
grep -rq -e "$PW" -e "$RPW" "$T/dump.log" "$T/b2" && bad "B3 secret leaked" || ok "B3 no password in log or bundle files"
grep -rqai -e 'Khach Tong Hop' -e '0910000001' "$T/b2" "$T/dump.log" && bad "B4 row data leaked" || ok "B4 no row data (names/phones) in any bundle file or log (content digests are age-encrypted)"
[ ! -e "$T/b2/production.dump" ] && [ ! -e "$T/b2/content.txt" ] && [ -s "$T/b2/content.txt.age" ] && ok "B5 plaintext dump and content digests shredded; only .age copies" || bad B5
cp -r "$T/b2" "$T/b2-pristine"

restore() { BUNDLE="$1" bash "$REPO/scripts/backup/m4-restore-rehearsal.sh" > "$2" 2>&1; }
if restore "$T/b2" "$T/r2.log"; then ok "R1 $(grep -o 'M4_RESTORE status=PASS.*' "$T/r2.log" | cut -c1-200)"; else cat "$T/r2.log"; bad R1; fi
grep -q 'database=restored' "$T/r2.log" && grep -q 'ownership_preserving=true' "$T/r2.log" && grep -q 'security=identical roles=identical' "$T/r2.log" \
  && ok "R2 single ownership-preserving restore is the gate: counts, content, objects, owners, per-object security, roles identical" || bad R2
rs() { docker exec -i "$SCR" psql -U postgres -d restored -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
[ "$(rs -c "select count(*) from dpg_commerce.orders")" = 3 ] && [ "$(rs -c "select count(*) from dpg_commerce.orders where code='$wcode'")" = 0 ] && ok "R3 restored orders = snapshot (3); the order committed during the dump is absent" || bad R3
[ "$(rs -c "select pg_get_userbyid(proowner) || ':' || prosecdef from pg_proc where oid = 'dpg_commerce.order_submit(jsonb,text,text)'::regprocedure")" = 'dpg_commerce_owner:true' ] && ok "R4 SECURITY DEFINER order_submit owned by dpg_commerce_owner" || bad R4
[ "$(rs -c "select has_function_privilege('dpg_commerce_intake','dpg_commerce.order_submit(jsonb,text,text)','EXECUTE')::text || has_function_privilege('dpg_commerce_intake','dpg_commerce.status_guard()','EXECUTE')::text || has_schema_privilege('dpg_commerce_intake','dpg_app','USAGE')::text")" = 'truefalsefalse' ] && ok "R5 effective privileges restored: intake EXECUTE order_submit only, no dpg_app usage" || bad R5
[ "$(rs -c "select relrowsecurity::text || relforcerowsecurity::text from pg_class where oid = 'dpg_app.owner_notes'::regclass")" = truetrue ] && [ "$(rs -c "select count(*) from pg_policies where policyname='owner_notes_own' and qual like '%auth.uid()%'")" = 1 ] && ok "R6 RLS enable/force + auth.uid() policy restored (platform prerequisite applied)" || bad R6
maxid="$(rs -c "select max(id) from dpg_commerce.orders")"
newcode="$(rs -c "set role dpg_commerce_intake; select dpg_commerce.order_submit(jsonb_build_object('customerName','Khach Tong Hop','customerPhone','0939999999','deliveryAddress','1 Duong Tong Hop, Q1','items',jsonb_build_array(jsonb_build_object('productId',1,'quantity',1)),'expectedTotalVnd',1000000), 'post-restore-1', md5('pr')) ->> 'code'")"
[ -n "$newcode" ] && [ "$(rs -c "select id from dpg_commerce.orders where code = '$newcode'")" -gt "$maxid" ] && ok "R7 SECURITY DEFINER intake works after restore; next id > restored max ($maxid)" || bad R7
if rs -c "set role dpg_commerce_intake; select count(*) from dpg_commerce.orders" >/dev/null 2>&1; then bad "R8 intake direct read"; else ok "R8 intake role still cannot read tables directly"; fi
if REPO="$REPO" bash "$REPO/scripts/backup/m4-reader-proof.sh" > "$T/proof.log" 2>&1; then ok "L1 reader proof PASS: identical dump inventory, $(grep -c 'DENIED sqlstate=42501' "$T/proof.log") denials with SQLSTATE 42501 (read-only default off), BYPASSRLS required"; else cat "$T/proof.log"; bad L1; fi

# ---- historical v1 bundle produced exactly like the pinned base revision (2 schemas, no scope.json) ----
v1="$T/b1"; mkdir -p "$v1"; chmod 700 "$v1"
git -C "$REPO" show "$V1_BASE:scripts/backup/m5-manifest.sql" > "$T/m5-manifest-base.sql"
pgr() { docker run --rm -i --network "$NET" -e DATABASE_URL="$DBURL" "$POSTGRES_IMAGE" psql "$DBURL" -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }
pgr -c "select format('select %L || '' '' || count(*) from %I.%I;', schemaname || '.' || tablename, schemaname, tablename) from pg_tables where schemaname in ('dpg_app','dpg_control') order by 1" | pgr -f - | sort > "$v1/row-counts.txt"
pgr -f - < "$T/m5-manifest-base.sql" > "$v1/objects.txt"
pgr -f - < "$REPO/scripts/backup/m5-manifest.sql" > "$T/objects-new-default.txt"
cmp -s "$v1/objects.txt" "$T/objects-new-default.txt" && ok "C1 m5-manifest.sql without variables is byte-identical to base $V1_BASE (v1 default bytes preserved)" || bad C1
docker run --rm --network "$NET" "$POSTGRES_IMAGE" pg_dump "$DBURL" --format=custom --compress=6 --no-owner --schema=dpg_app --schema=dpg_control > "$v1/production.dump"
sha="$(sha256sum "$v1/production.dump" | cut -d' ' -f1)"; age -r "$AGE_RECIPIENT" -o "$v1/production.dump.age" "$v1/production.dump"; rm -f "$v1/production.dump"
printf 'backup_id=m4-local-v1\nplaintext_dump_sha256=%s\ntables=%s\n' "$sha" "$(wc -l < "$v1/row-counts.txt")" > "$v1/manifest.txt"
( cd "$v1" && sha256sum production.dump.age manifest.txt row-counts.txt objects.txt > SHA256SUMS )
if restore "$v1" "$T/r1.log"; then ok "C2 historical v1 bundle restores: $(grep -o 'gate=PASS.*' "$T/r1.log")"; else cat "$T/r1.log"; bad C2; fi
grep -q 'coverage=limited' "$T/r1.log" && grep -q 'dpg_commerce_NOT_covered' "$T/r1.log" && ! grep -q 'coverage=full' "$T/r1.log" && ok "C3 v1 bundle honestly reported coverage=limited, dpg_commerce NOT covered" || bad C3
[ "$(docker exec "$SCR" psql -U postgres -At -c "select to_regnamespace('dpg_commerce') is null")" = t ] && ok "C4 v1 restore contains no dpg_commerce" || bad C4

# ---- negative bundle cases (each must end without status=PASS, with the expected sanitized reason) ----
neg() { local name="$1" mutate="$2" expect="$3" env="${4:-}"; rm -rf "$T/n"; cp -r "$T/b2-pristine" "$T/n"; ( cd "$T/n" && eval "$mutate" )
  if env $env BUNDLE="$T/n" bash "$REPO/scripts/backup/m4-restore-rehearsal.sh" > "$T/n.log" 2>&1; then bad "$name (restore passed)"
  elif grep -q 'M4_RESTORE status=PASS' "$T/n.log"; then bad "$name (PASS printed)"
  elif grep -Eq -e 'Khach|09[0-9]{8}|DETAIL|ERROR:' "$T/n.log"; then bad "$name (unsanitized output)"
  elif grep -Eq "$expect" "$T/n.log"; then ok "$name -> $(grep -Eo "$expect" "$T/n.log" | head -1)"; else tail -4 "$T/n.log"; bad "$name (unexpected reason)"; fi; }
resum() { sha256sum $(awk '{print $2}' SHA256SUMS) > SHA256SUMS; }
neg "N2 tampered scope.json (schemas narrowed)" "sed -i 's/,\"dpg_commerce\"//' scope.json; resum" 'scope_untrusted'
neg "N3 unknown scope version" "sed -i 's/\"version\":2/\"version\":9/' scope.json; resum" 'scope_untrusted'
neg "N4 malformed scope.json" "echo '{' > scope.json; resum" 'scope_untrusted'
neg "N5 downgrade: scope.json removed, other v2 files kept" "rm -f scope.json; sed -i '/scope.json/d' SHA256SUMS" 'v2_bundle_without_scope'
neg "N6 mandatory v2 field missing (discovered=)" "sed -i '/^discovered=/d' manifest.txt; resum" 'v2_field_missing_discovered'
neg "N7 manifest scope/schema inconsistency" "sed -i 's/^schemas=.*/schemas=dpg_app,dpg_control/' manifest.txt; resum" 'manifest_schemas_mismatch'
neg "N8 checksum mismatch (owners.txt edited, sums not updated)" "sed -i '1s/\$/x/' owners.txt" 'checksum_mismatch'
neg "N9 missing archive" "rm -f production.dump.age" 'checksum_mismatch'
neg "N10 corrupt archive with recomputed checksum" "head -c 2000 /dev/urandom > production.dump.age; resum" 'decrypt_failed'
neg "N11 v2 bundle missing security.txt" "rm -f security.txt; sed -i '/security.txt/d' SHA256SUMS" 'v2_file_missing_security'
neg "N12 truncated archive re-encrypted with matching sha" "age -d -i '$T/key.txt' production.dump.age > p.dump; head -c \$((\$(stat -c %s p.dump)/2)) p.dump > t.dump; sed -i \"s/^plaintext_dump_sha256=.*/plaintext_dump_sha256=\$(sha256sum t.dump | cut -d' ' -f1)/\" manifest.txt; age -r '$AGE_RECIPIENT' -o production.dump.age t.dump; rm -f p.dump t.dump; resum" 'archive_unreadable|toc_inventory_differs|gate'
neg "N13 row-count mismatch" "sed -i 's/^dpg_commerce.orders [0-9]*/dpg_commerce.orders 999/' row-counts.txt; resum" 'toc_inventory_differs|gate'
neg "N14 ACL swap with the SAME count (grantee moved between two tables)" "a=\$(grep -n '^tacl dpg_commerce.orders dpg_admin_api SELECT' security.txt | head -1 | cut -d: -f1); b=\$(grep -n '^tacl dpg_commerce.quotes dpg_admin_api SELECT' security.txt | head -1 | cut -d: -f1); sed -i \"\${a}s/dpg_admin_api/dpg_runtime/\" security.txt; sed -i \"\${b}s/dpg_admin_api/dpg_runtime/\" security.txt; resum" 'security_differs'
neg "N15 RLS flags swapped between two tables (same totals)" "sed -i -E 's/^(rls dpg_commerce.orders) true false$/\\1 true true/; s/^(rls dpg_app.products) true true$/\\1 true false/' security.txt; resum" 'security_differs'
neg "N16 grant option flipped (same counts)" "sed -i -E '0,/^tacl dpg_commerce.events dpg_admin_api SELECT ([a-z_]+) false$/s//tacl dpg_commerce.events dpg_admin_api SELECT \\1 true/' security.txt; resum" 'security_differs'
neg "N17 missing platform dependency (no auth.uid stub)" "true" 'gate|platform_prerequisites' "SCRATCH_PREREQS=/dev/null"
neg "N18 referenced role missing from roles.txt" "sed -i '/^roleexists dpg_commerce_intake\$/d; /^roleattr dpg_commerce_intake /d; / dpg_commerce_intake admin=/d' roles.txt; resum" 'gate|roles_differ'
neg "N19 sequence definition mismatch" "sed -i -E '0,/^seqdef dpg_commerce.orders_id_seq ([a-z]+) 1 1 /s//seqdef dpg_commerce.orders_id_seq \\1 1 2 /' security.txt; resum" 'security_differs'

# ---- unsafe sequence state (last_value = max, is_called = false would hand out a duplicate id) ----
src -c "select setval('dpg_commerce.orders_id_seq', (select max(id) from dpg_commerce.orders), false)" >/dev/null
DATABASE_URL="$DBURL" WORK="$T/bs" timeout 600 bash "$REPO/scripts/backup/m4-backup-dump.sh" > "$T/ds.log" 2>&1 || true
if restore "$T/bs" "$T/rs.log"; then bad "N20 unsafe sequence passed"; else grep -q 'sequence_unsafe dpg_commerce.orders' "$T/rs.log" && ok "N20 sequence with is_called=false at max -> FAIL sequence_not_safe" || { tail -3 "$T/rs.log"; bad N20; }; fi
src -c "select setval('dpg_commerce.orders_id_seq', (select max(id) from dpg_commerce.orders), true)" >/dev/null

# ---- concurrent schema drift during the dump: a new dpg_* schema appears while the snapshot is held ----
( for _ in $(seq 1 400); do
    if [ "$(src -c "select count(*) from pg_stat_activity where usename='dpg_backup_reader' and state like 'idle in transaction%'")" -ge 1 ]; then
      src -c "create schema dpg_core; create table dpg_core.t(id int)" >/dev/null; exit 0; fi; sleep 0.02; done ) & drifter=$!
if DATABASE_URL="$DBURL" WORK="$T/bd" timeout 600 bash "$REPO/scripts/backup/m4-backup-dump.sh" > "$T/dd.log" 2>&1; then bad "N21 drift not detected"; else
  grep -q 'schema_set_changed_during_dump\|snapshot_scope' "$T/dd.log" && [ ! -e "$T/bd/SHA256SUMS" ] && ok "N21 dpg_core created during the dump -> FAIL $(grep -o 'reason=[a-z_]*' "$T/dd.log" | head -1), no bundle" || { cat "$T/dd.log"; bad N21; }; fi
wait $drifter || true; src -c "drop schema if exists dpg_core cascade" >/dev/null

# ---- negative preflight cases on the source (each restored afterwards) ----
npre() { local name="$1" setup="$2" undo="$3" expect="$4" url="${5:-}"; src -c "$setup" >/dev/null
  if pre "$url"; then bad "$name (preflight passed)"; elif grep -q "$expect" "$T/pre.log"; then ok "$name -> $expect"; else cat "$T/pre.log"; bad "$name"; fi; src -c "$undo" >/dev/null; }
npre "N22 uncovered dpg_* schema with tables (future dpg_core)" "create schema dpg_core; create table dpg_core.t(id int)" "drop schema dpg_core cascade" 'uncovered_schema'
npre "N23 missing sequence SELECT" "revoke select on sequence dpg_commerce.events_id_seq from dpg_backup_reader" "grant select on sequence dpg_commerce.events_id_seq to dpg_backup_reader" 'reader_missing_sequence_select'
npre "N24 reader gains table DML" "grant insert on dpg_commerce.events to dpg_backup_reader" "revoke insert on dpg_commerce.events from dpg_backup_reader" 'reader_has_write_privileges'
npre "N25 reader gains a COLUMN-only update" "grant update (staff_note) on dpg_commerce.orders to dpg_backup_reader" "revoke update (staff_note) on dpg_commerce.orders from dpg_backup_reader" 'reader_has_write_privileges'
npre "N26 reader gains INSERT on an updatable view" "set role dpg_commerce_owner; create view dpg_commerce.v_proof as select * from dpg_commerce.rate_buckets; grant insert on dpg_commerce.v_proof to dpg_backup_reader" "drop view dpg_commerce.v_proof" 'reader_has_write_privileges'
npre "N27 reader gains sequence USAGE" "grant usage on sequence dpg_commerce.orders_id_seq to dpg_backup_reader" "revoke usage on sequence dpg_commerce.orders_id_seq from dpg_backup_reader" 'reader_can_mutate_sequences'
npre "N28 reader gains EXECUTE on a SECURITY DEFINER entry point" "grant execute on function dpg_commerce.order_submit(jsonb,text,text) to dpg_backup_reader" "revoke execute on function dpg_commerce.order_submit(jsonb,text,text) from dpg_backup_reader" 'reader_can_execute_security_definer'
npre "N29 reader inherits a role membership" "grant dpg_commerce_owner to dpg_backup_reader" "revoke dpg_commerce_owner from dpg_backup_reader" 'reader_has_memberships'
npre "N30 reader gains CREATE on a scope schema" "grant create on schema dpg_commerce to dpg_backup_reader" "revoke create on schema dpg_commerce from dpg_backup_reader" 'reader_can_create'
npre "N31 reader gains a grant option" "grant select on dpg_commerce.orders to dpg_backup_reader with grant option" "revoke grant option for select on dpg_commerce.orders from dpg_backup_reader" 'reader_has_grant_option'
npre "N32 reader attributes changed (connection limit)" "alter role dpg_backup_reader connection limit 3" "alter role dpg_backup_reader connection limit 2" 'reader_attributes_differ'
npre "N33 unexpected role (owner/operator credential, no fallback PASS)" "select 1" "select 1" 'not_least_privilege_reader' "$OPURL"
src -c "set role dpg_commerce_owner; create table dpg_commerce.future_probe(id int)" >/dev/null && pre && ok "D1 default ACL: a new dpg_commerce table is readable automatically" || { cat "$T/pre.log"; bad D1; }
src -c "drop table dpg_commerce.future_probe" >/dev/null
src -c "alter default privileges for role dpg_commerce_owner in schema dpg_commerce revoke select on tables from dpg_backup_reader; set role dpg_commerce_owner; create table dpg_commerce.future_probe2(id int)" >/dev/null
if pre; then bad "N34 missing default ACL not detected"; else grep -q 'reader_missing_table_select' "$T/pre.log" && ok "N34 missing default ACL -> new table unreadable -> preflight FAIL" || bad N34; fi
src -c "drop table dpg_commerce.future_probe2; alter default privileges for role dpg_commerce_owner in schema dpg_commerce grant select on tables to dpg_backup_reader" >/dev/null

# ---- grant rollback: refuses an intervening change; restores the exact baseline; preserves a pre-existing self-grant ----
src -c "grant insert on dpg_commerce.events to dpg_backup_reader" >/dev/null
if g002 _rollback > "$T/rb.txt" 2>&1; then bad "G4 rollback ignored an intervening change"; else grep -q 'intervening change' "$T/rb.txt" && ok "G4 rollback refuses when reader privileges differ from what 002 granted" || { cat "$T/rb.txt"; bad G4; }; fi
src -c "revoke insert on dpg_commerce.events from dpg_backup_reader" >/dev/null
acl_base() { src -c "select md5(string_agg(x, ',' order by x)) from (select c.oid::regclass || ':' || a.grantee::regrole || ':' || a.grantor::regrole || ':' || a.privilege_type || ':' || a.is_grantable as x from pg_class c join pg_namespace n on n.oid = c.relnamespace cross join lateral aclexplode(c.relacl) a where n.nspname = 'dpg_commerce' and a.grantee <> 'dpg_backup_reader'::regrole) s"; }
others_before="$(acl_base)"
g002 _rollback > "$T/rb.txt" 2>&1 && grep -q '^DPG42_ROLLBACK_VERIFIED' "$T/rb.txt" && [ "$(acl_base)" = "$others_before" ] && [ "$(src -c "select has_schema_privilege('dpg_backup_reader','dpg_commerce','USAGE')")" = f ] \
  && ok "G5 rollback restores the exact baseline; every non-reader ACL entry identical" || { cat "$T/rb.txt"; bad G5; }
src -c "grant dpg_commerce_owner to dpg_operator with inherit false, set true granted by dpg_operator" >/dev/null 2>&1 || op -c "grant dpg_commerce_owner to dpg_operator with inherit false, set true" >/dev/null
selfgrant() { src -c "select count(*) from pg_auth_members where roleid='dpg_commerce_owner'::regrole and member='dpg_operator'::regrole and grantor='dpg_operator'::regrole"; }
pre_self="$(selfgrant)"
g002 "" >/dev/null 2>&1 && g002 _rollback >/dev/null 2>&1 && [ "$pre_self" = 1 ] && [ "$(selfgrant)" = 1 ] && ok "G6 a pre-existing operator self-grant survives 002 + rollback unchanged" || bad "G6 (before=$pre_self after=$(selfgrant))"
op -c "revoke dpg_commerce_owner from dpg_operator" >/dev/null 2>&1 || true
if DATABASE_URL="$DBURL" WORK="$T/bf" timeout 600 bash "$REPO/scripts/backup/m4-backup-dump.sh" > "$T/df.log" 2>&1; then bad "N35 dump without grant must fail"; else
  ! grep -q 'status=PASS' "$T/df.log" && [ ! -e "$T/bf/SHA256SUMS" ] && ! grep -Eq 'ERROR:|DETAIL' "$T/df.log" && ok "N35 dump without the commerce grant fails closed: $(grep -o 'stage=[a-z_]* reason=[a-z_]*' "$T/df.log"), no bundle, sanitized" || { cat "$T/df.log"; bad N35; }; fi

echo "----"; printf '%s\n' "${results[@]}" > "${DPG42_RESULTS:-/dev/null}"
echo "DPG42 local proof: $pass PASS, $fail FAIL"
test "$fail" = 0
