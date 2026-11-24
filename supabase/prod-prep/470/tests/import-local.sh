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
snapshot() { "${S[@]}" -c "select json_build_object('db_size_bytes', pg_database_size(current_database()), 'rows', (select json_agg(t) from (select id, sku, category_id, brand_id, is_active, version, canonical_price_status, regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd, canonical_price_checked_at from dpg_app.products where category_id=1 and brand_id=1 order by id) t))" > $T/snap.json; }
state() { "${S[@]}" -c "select string_agg(id||':'||coalesce(canonical_price_status,'-')||':'||coalesce(regular_price_vnd::text,'-')||':'||coalesce(promotional_price_vnd::text,'-')||':'||coalesce(online_voucher_amount_vnd::text,'-')||':'||coalesce(to_char(canonical_price_checked_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI'),'-')||':v'||version, ' ' order by id) from dpg_app.products where category_id=1"; }
expect_state() { local got; got=$(state); [ "$got" = "$1" ] || { echo "FAIL state: $got"; echo "    want:  $1"; exit 1; }; }
snapshot
SHA=$(sha256sum $T/p.csv | cut -d' ' -f1)
run() { npx tsx scripts/hita-price-audit/prod-import.mts $T/p.csv --csv-sha256 "$SHA" --candidate-sha "$CAND" --inventory $T/inv.json --db-snapshot $T/snap.json --now 2026-11-24T01:00:00Z "$@"; }
run > $T/dry.json; grep -q '"mode": "dry-run"' $T/dry.json; test ! -e $T/out
echo "PASS dry-run by default writes nothing"
run --out $T/out --batch-size 2 > $T/emit.json; PLAN=$(node -p "require('$T/emit.json').plan_sha"); test -f $T/out/batch-0002-apply.sql
grep -q '"release_binding_note": "identity for the manifest only; execution needs the Owner GO"' $T/emit.json
echo "PASS emit-sql produced 2 batches + ledger (nothing executed); release binding is identity, not authorisation"
O=("${PSQL[@]}" -U dpg_operator -d "$DB")
INIT="1:-:-:-:-:-:v1 2:-:-:-:-:-:v1 3:-:-:-:-:-:v1 4:-:-:-:-:-:v1 6:-:-:-:-:-:v1"
expect_state "$INIT"
if "${O[@]}" -v approved_sha=wrong -f $T/out/batch-0001-apply.sql >/dev/null 2>&1; then echo "FAIL: ran with wrong plan sha"; exit 1; fi
if "${O[@]}" -v approved_sha= -f $T/out/batch-0001-apply.sql >/dev/null 2>&1; then echo "FAIL: ran without approval"; exit 1; fi
"${S[@]}" -c "update dpg_control.target_contract set project_name='dongphugia-staging'"
if "${O[@]}" -v approved_sha=$PLAN -f $T/out/batch-0001-apply.sql >/dev/null 2>&1; then echo "FAIL: ran on a non-Production target identity"; exit 1; fi
"${S[@]}" -c "update dpg_control.target_contract set project_name='dongphugia-runtime'"
"${S[@]}" -c "update dpg_app.brands set slug='toto-x' where id=1"
if "${O[@]}" -v approved_sha=$PLAN -f $T/out/batch-0001-apply.sql >/dev/null 2>&1; then echo "FAIL: ran with a changed brand identity"; exit 1; fi
"${S[@]}" -c "update dpg_app.brands set slug='toto' where id=1"
expect_state "$INIT"
echo "PASS batch refuses wrong/empty approval, wrong target identity, changed brand identity (nothing written)"
# batch 1 = ids 1,2 ; batch 2 = ids 3,4
"${O[@]}" -v approved_sha=$PLAN -f $T/out/batch-0001-apply.sql >/dev/null
expect_state "1:PRICE_VERIFIED:1000000:-:-:2026-11-23T18:00:v2 2:PRICE_VERIFIED:2000000:1800000:100000:2026-11-23T18:00:v2 3:-:-:-:-:-:v1 4:-:-:-:-:-:v1 6:-:-:-:-:-:v1"
echo "PASS batch 1 applied exactly ids 1,2 (status, prices, checked-at, version+1)"
# concurrent Admin edit on id 3 between batches -> batch 2 must abort atomically (id 4 untouched too)
"${S[@]}" -c "update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=777000, canonical_price_checked_at='2026-11-24T02:00:00Z', version=version+1 where id=3"
if "${O[@]}" -v approved_sha=$PLAN -f $T/out/batch-0002-apply.sql >/dev/null 2>&1; then echo "FAIL: batch 2 overwrote a concurrent edit"; exit 1; fi
EDITED="1:PRICE_VERIFIED:1000000:-:-:2026-11-23T18:00:v2 2:PRICE_VERIFIED:2000000:1800000:100000:2026-11-23T18:00:v2 3:PRICE_VERIFIED:777000:-:-:2026-11-24T02:00:v2 4:-:-:-:-:-:v1 6:-:-:-:-:-:v1"
expect_state "$EDITED"
echo "PASS partial failure: batch 2 aborted as a whole on a concurrent edit; nothing stale written, id 4 untouched"
# re-apply of batch 1 aborts (idempotent no-op instead of a double write)
if "${O[@]}" -v approved_sha=$PLAN -f $T/out/batch-0001-apply.sql >/dev/null 2>&1; then echo "FAIL: re-apply wrote again"; exit 1; fi
expect_state "$EDITED"
# rerun: fresh snapshot -> new plan only for id 4; id 3 (newer Admin edit) is skipped and listed, never overwritten
snapshot; run --out $T/out2 > $T/emit2.json; PLAN2=$(node -p "require('$T/emit2.json').plan_sha")
node -e 'const r=require(process.argv[1]); if(r.to_change!==1||r.skipped_newer_db_edit!==1||r.newer_db_edit_ids[0]!==3||r.unchanged!==2) {console.log(r);process.exit(1)}' $T/emit2.json
[ "$PLAN2" != "$PLAN" ]
"${O[@]}" -v approved_sha=$PLAN2 -f $T/out2/batch-0001-apply.sql >/dev/null
expect_state "1:PRICE_VERIFIED:1000000:-:-:2026-11-23T18:00:v2 2:PRICE_VERIFIED:2000000:1800000:100000:2026-11-23T18:00:v2 3:PRICE_VERIFIED:777000:-:-:2026-11-24T02:00:v2 4:NOT_FOUND:-:-:-:2026-11-23T18:00:v2 6:-:-:-:-:-:v1"
echo "PASS rerun planned only id 4 (new plan SHA); the newer Admin edit on id 3 was kept"
# rollback of plan 1 / batch 1: restores ids 1,2 to their exact prior state, version keeps increasing
"${O[@]}" -v approved_sha=$PLAN -f $T/out/batch-0001-rollback.sql >/dev/null
expect_state "1:-:-:-:-:-:v3 2:-:-:-:-:-:v3 3:PRICE_VERIFIED:777000:-:-:2026-11-24T02:00:v2 4:NOT_FOUND:-:-:-:2026-11-23T18:00:v2 6:-:-:-:-:-:v1"
echo "PASS rollback restored exactly the rows batch 1 applied (status/prices/checked-at), version monotonic (v3)"
# rollback of plan 1 / batch 2 (never applied) must refuse: it would otherwise clobber the Admin edit on id 3
if "${O[@]}" -v approved_sha=$PLAN -f $T/out/batch-0002-rollback.sql >/dev/null 2>&1; then echo "FAIL: rolled back a batch that was never applied"; exit 1; fi
# Admin edits id 4 after plan 2 -> plan 2 rollback must refuse instead of restoring a stale value
"${S[@]}" -c "update dpg_app.products set canonical_price_status='CONTACT_VERIFIED', canonical_price_checked_at='2026-11-24T03:00:00Z', version=version+1 where id=4"
if "${O[@]}" -v approved_sha=$PLAN2 -f $T/out2/batch-0001-rollback.sql >/dev/null 2>&1; then echo "FAIL: rollback overwrote a newer edit"; exit 1; fi
expect_state "1:-:-:-:-:-:v3 2:-:-:-:-:-:v3 3:PRICE_VERIFIED:777000:-:-:2026-11-24T02:00:v2 4:CONTACT_VERIFIED:-:-:-:2026-11-24T03:00:v3 6:-:-:-:-:-:v1"
echo "PASS rollback refuses rows that were never applied or were edited since (no stale overwrite)"
node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse); if(l.length!==4||l.some(x=>!("before_checked_at" in x)||x.version_before!==1||x.brand_id!==1))process.exit(1)' $T/out/ledger.jsonl
echo "PASS ledger keeps full prior state (status, prices, checked-at, version, brand) for every planned row"
# stop rule: headroom
node -e 'const s=require(process.argv[1]); s.db_size_bytes=360*1024*1024; require("fs").writeFileSync(process.argv[1],JSON.stringify(s))' $T/snap.json
if run > $T/stop.json 2>&1; then echo "FAIL: planner did not stop on headroom"; exit 1; fi; grep -q DB_HEADROOM_INSUFFICIENT $T/stop.json
echo "PASS planner stops when headroom is insufficient"
echo "ALL PASS"
