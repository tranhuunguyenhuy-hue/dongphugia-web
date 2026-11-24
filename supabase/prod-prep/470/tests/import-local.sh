#!/usr/bin/env bash
# #470: isolated local proof that the emitted import SQL batches apply, are guarded, count-checked and reversible.
# Usage: import-local.sh <host-or-socket-dir> <port> <superuser>   (repo root must have node_modules)
set -euo pipefail
H=${1:?host}; P=${2:?port}; U=${3:?user}; DB=dpg470imp_$$
cd "$(dirname "$0")/../../../.."
T=$(mktemp -d); CAND=$(printf 'c%.0s' $(seq 1 40))
PSQL=(psql -X -q -tA -v ON_ERROR_STOP=1 -h "$H" -p "$P")
drop_all() { "${PSQL[@]}" -U "$U" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true
  for r in dpg_operator dpg_migration dpg_admin_api dpg_public_catalogue dpg_runtime dpg_readonly authenticated dpg_direct_import; do "${PSQL[@]}" -U "$U" -d postgres -c "drop role if exists $r" >/dev/null 2>&1 || true; done; }
trap 'drop_all; rm -rf "$T"' EXIT; drop_all
"${PSQL[@]}" -U "$U" -d postgres -c "create database $DB"
S=("${PSQL[@]}" -U "$U" -d "$DB"); D=supabase/prod-prep/470
"${S[@]}" -f $D/tests/fixture.sql >/dev/null; "${S[@]}" -f $D/tests/seed.sql >/dev/null
for f in 001_canonical_price_columns 002_canonical_price_grants; do "${PSQL[@]}" -U dpg_operator -d "$DB" -v approved_sha=x -f $D/$f.sql >/dev/null; done
# fixture CSV: id1 EXACT, id2 EXACT+promo+voucher, id3 CONTACT, id4 NOT_FOUND, id6 BLOCKED (never written)
node -e '
const cols="dpg_id,sku,product_name,category,is_active,hita_exact_sku,hita_url,regular_price_vnd,promotional_price_vnd,online_voucher_amount_vnd,currency,source_checked_at_utc,price_valid_until,voucher_condition,method,status,reason,review_status".split(",");
const R=(id,sku,o)=>({dpg_id:id,sku,product_name:"p",category:"thiet-bi-ve-sinh",is_active:"true",hita_exact_sku:sku,hita_url:`https://hita.com.vn/p-${id}-${id}.html`,regular_price_vnd:"",promotional_price_vnd:"",online_voucher_amount_vnd:"",currency:"VND",source_checked_at_utc:"2026-11-23T18:00:00.000Z",price_valid_until:"2026-12-01",voucher_condition:"",method:"T",status:"EXACT",reason:"",review_status:"FRESH_CRAWL_PENDING_OWNER_REVIEW",...o});
const rows=[R("1","VS-OK",{regular_price_vnd:"1000000"}),R("2","VS-PROMO",{regular_price_vnd:"2000000",promotional_price_vnd:"1800000",online_voucher_amount_vnd:"100000",voucher_condition:"Online"}),R("3","VS-NOPRICE",{status:"CONTACT"}),R("4","VS-CONTACT",{status:"NOT_FOUND",hita_exact_sku:"",hita_url:""}),R("6","VS-OUT",{status:"BLOCKED",review_status:"BLOCKED_NOT_NO_PRICE"})];
const q=v=>`"${String(v).replaceAll("\"","\"\"")}"`;
require("fs").writeFileSync(process.argv[1],cols.join(",")+"\r\n"+rows.map(r=>cols.map(c=>q(r[c])).join(",")).join("\r\n")+"\r\n");
require("fs").writeFileSync(process.argv[2],JSON.stringify([1,2,3,4,6].map((id,i)=>({id,sku:["VS-OK","VS-PROMO","VS-NOPRICE","VS-CONTACT","VS-OUT"][i],is_active:true}))));
' $T/p.csv $T/inv.json
snapshot() { "${S[@]}" -c "select json_build_object('db_size_bytes', pg_database_size(current_database()), 'rows', (select json_agg(t) from (select id, sku, category_id, is_active, version, canonical_price_status, regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd from dpg_app.products where category_id=1 order by id) t))" > $T/snap.json; }
snapshot
SHA=$(sha256sum $T/p.csv | cut -d' ' -f1)
run() { npx tsx scripts/hita-price-audit/prod-import.mts $T/p.csv --csv-sha256 "$SHA" --candidate-sha "$CAND" --inventory $T/inv.json --db-snapshot $T/snap.json --now 2026-11-24T01:00:00Z "$@"; }
run > $T/dry.json; grep -q '"mode": "dry-run"' $T/dry.json; test ! -e $T/out
echo "PASS dry-run by default writes nothing"
run --out $T/out > $T/emit.json; PLAN=$(node -p "require('$T/emit.json').plan_sha"); test -f $T/out/batch-0001-apply.sql
echo "PASS emit-sql produced batches + ledger (nothing executed)"; "${S[@]}" -c "select count(*) from dpg_app.products where canonical_price_status is not null" | grep -qx 0
O=("${PSQL[@]}" -U dpg_operator -d "$DB")
if "${O[@]}" -v approved_sha=wrong -f $T/out/batch-0001-apply.sql >/dev/null 2>&1; then echo "FAIL: ran with wrong plan sha"; exit 1; fi
if "${O[@]}" -v approved_sha= -f $T/out/batch-0001-apply.sql >/dev/null 2>&1; then echo "FAIL: ran without approval"; exit 1; fi
echo "PASS batch refuses wrong/empty approval"
"${O[@]}" -v approved_sha=$PLAN -f $T/out/batch-0001-apply.sql >/dev/null
"${S[@]}" -c "select string_agg(id||':'||coalesce(canonical_price_status,'-')||':'||coalesce(regular_price_vnd::text,'-')||':'||coalesce(promotional_price_vnd::text,'-')||':'||coalesce(online_voucher_amount_vnd::text,'-')||':v'||version, ' ' order by id) from dpg_app.products where category_id=1" > $T/after.txt
grep -qx "1:PRICE_VERIFIED:1000000:-:-:v2 2:PRICE_VERIFIED:2000000:1800000:100000:v2 3:CONTACT_VERIFIED:-:-:-:v2 4:NOT_FOUND:-:-:-:v2 6:-:-:-:-:v1" $T/after.txt || { cat $T/after.txt; exit 1; }
echo "PASS apply wrote exactly the 4 planned rows; BLOCKED row untouched (NULL), version bumped"
if "${O[@]}" -v approved_sha=$PLAN -f $T/out/batch-0001-apply.sql >/dev/null 2>&1; then echo "FAIL: second apply should abort on row-count mismatch (idempotent no-op)"; exit 1; fi
echo "PASS re-apply aborts (row-count/basis check) instead of double writing"
snapshot; run > $T/dry2.json; grep -q '"to_change": 0' $T/dry2.json
echo "PASS re-plan after apply = 0 changes (idempotent)"
"${O[@]}" -v approved_sha=$PLAN -f $T/out/batch-0001-rollback.sql >/dev/null
"${S[@]}" -c "select count(*) from dpg_app.products where canonical_price_status is not null or regular_price_vnd is not null or canonical_price_checked_at is not null" | grep -qx 0
echo "PASS rollback batch restored the pre-import state"
# stop rule: headroom
node -e 'const s=require(process.argv[1]); s.db_size_bytes=360*1024*1024; require("fs").writeFileSync(process.argv[1],JSON.stringify(s))' $T/snap.json
if run > $T/stop.json 2>&1; then echo "FAIL: planner did not stop on headroom"; exit 1; fi; grep -q DB_HEADROOM_INSUFFICIENT $T/stop.json
echo "PASS planner stops when headroom is insufficient"
echo "ALL PASS"
