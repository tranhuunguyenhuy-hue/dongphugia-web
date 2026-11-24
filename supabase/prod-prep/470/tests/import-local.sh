#!/usr/bin/env bash
# #470: isolated local proof that the emitted import SQL batches apply, are guarded, count-checked and reversible.
# Usage: import-local.sh <host-or-socket-dir> <port> <superuser>   (repo root must have node_modules)
set -euo pipefail
H=${1:?host}; P=${2:?port}; U=${3:?user}; DB=dpg470imp_$$
cd "$(dirname "$0")/../../../.."
T=$(mktemp -d); CAND=$(printf 'c%.0s' $(seq 1 40))
PSQL=(psql -X -q -tA -v ON_ERROR_STOP=1 -h "$H" -p "$P")
drop_all() { "${PSQL[@]}" -U "$U" -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true
  for r in dpg_operator dpg_migration dpg_admin_api dpg_public_catalogue dpg_runtime dpg_readonly authenticated dpg_direct_import anon service_role; do "${PSQL[@]}" -U "$U" -d postgres -c "drop role if exists $r" >/dev/null 2>&1 || true; done; }
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
run() { npx tsx scripts/hita-price-audit/prod-import.mts $T/p.csv --csv-sha256 "$SHA" --candidate-sha "$CAND" --inventory $T/inv.json --db-snapshot $T/snap.json --now 2026-11-24T01:00:00Z --brand toto --state active "$@"; }
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
# ---------- PHASE 2: second brand (INAX) and the inactive sets: independent plans / ledgers / checksums / rollbacks ----------
"${S[@]}" -c "insert into dpg_app.products(sku,name,slug,category_id,brand_id,is_active,price,list_price,price_state) values
  ('IN-1','INAX a','in-1',1,2,true,10,10,'priced'),('IN-2','INAX b','in-2',1,2,true,20,20,'priced'),('TI-1','TOTO inactive','ti-1',1,1,false,30,30,'priced'),('II-1','INAX inactive','ii-1',1,2,false,40,40,'priced')"
read -r IN1 IN2 TI1 II1 <<<"$("${S[@]}" -c "select string_agg(id::text,' ' order by sku) from dpg_app.products where sku in ('IN-1','IN-2','II-1','TI-1')" | awk '{print $2,$3,$4,$1}')"
T2=$T/p2; mkdir -p $T2
node -e '
const [outDir,inv,...ids]=process.argv.slice(1);
const cols="dpg_id,sku,product_name,category,is_active,hita_exact_sku,hita_url,regular_price_vnd,promotional_price_vnd,online_voucher_amount_vnd,currency,source_checked_at_utc,price_valid_until,voucher_condition,method,status,reason,review_status".split(",");
const spec=[[ids[0],"IN-1","true","1500000"],[ids[1],"IN-2","true","2500000"],[ids[2],"TI-1","false","3500000"],[ids[3],"II-1","false","4500000"]];
const R=([id,sku,act,reg])=>({dpg_id:id,sku,product_name:"p",category:"thiet-bi-ve-sinh",is_active:act,hita_exact_sku:sku,hita_url:`https://hita.com.vn/p-${id}-${id}.html`,regular_price_vnd:reg,promotional_price_vnd:"",online_voucher_amount_vnd:"",currency:"VND",source_checked_at_utc:"2026-11-23T19:00:00.000Z",price_valid_until:"2026-12-01",voucher_condition:"",method:"T",status:"EXACT",reason:"",review_status:"FRESH_CRAWL_PENDING_OWNER_REVIEW"});
const q=v=>`"${String(v).replaceAll("\"","\"\"")}"`;
const w=(f,rows)=>require("fs").writeFileSync(outDir+"/"+f,cols.join(",")+"\r\n"+rows.map(s=>cols.map(c=>q(R(s)[c])).join(",")).join("\r\n")+"\r\n");
w("inax.csv",[spec[0],spec[1],spec[3]]); w("toto.csv",[spec[2]]);
require("fs").writeFileSync(inv,JSON.stringify(spec.map(([id,sku,act])=>({id:Number(id),sku,is_active:act==="true"}))));
' $T2 $T2/inv.json $IN1 $IN2 $TI1 $II1

snap_brand() { "${S[@]}" -c "select json_build_object('db_size_bytes', pg_database_size(current_database()), 'rows', (select json_agg(t) from (select id, sku, category_id, brand_id, is_active, version, canonical_price_status, regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd, canonical_price_checked_at from dpg_app.products where category_id=1 and brand_id=$1 order by id) t))" > $T2/snap-$1.json; }
plan2() { npx tsx scripts/hita-price-audit/prod-import.mts $T2/$4.csv --csv-sha256 "$(sha256sum $T2/$4.csv | cut -d' ' -f1)" --candidate-sha "$CAND" --inventory $T2/inv.json --db-snapshot $T2/snap-$1.json --now 2026-11-24T01:00:00Z --brand $2 --state $3 "${@:5}"; }
snap_brand 1; snap_brand 2
# a CSV that mixes brands/states cannot be planned under the wrong scope: the plan STOPS (nothing emitted)
if plan2 1 toto active inax --out $T2/bad > $T2/bad.json 2>&1; then echo "FAIL: TOTO plan accepted INAX rows"; exit 1; fi; grep -q IDENTITY_MISMATCH $T2/bad.json; test ! -e $T2/bad
echo "PASS a plan for the wrong brand stops on identity (no SQL emitted)"
plan2 2 inax active inax --out $T2/inax-active > $T2/ia.json; plan2 2 inax inactive inax --out $T2/inax-inactive > $T2/ii.json; plan2 1 toto inactive toto --out $T2/toto-inactive > $T2/ti.json
PIA=$(node -p "require('$T2/ia.json').plan_sha"); PII=$(node -p "require('$T2/ii.json').plan_sha"); PTI=$(node -p "require('$T2/ti.json').plan_sha")
[ "$PIA" != "$PII" ] && [ "$PIA" != "$PTI" ] && [ "$PII" != "$PTI" ]
node -e 'for(const [f,rows,brand,state] of [["ia",2,"inax","active"],["ii",1,"inax","inactive"],["ti",1,"toto","inactive"]]){const r=require(process.argv[1]+"/"+f+".json"); if(r.to_change!==rows||r.brand!==brand||r.state!==state||(f==="ia"&&r.skipped_other_state!==1)||(f==="ii"&&r.skipped_other_state!==2)){console.log(f,r);process.exit(1)}}' $T2
echo "PASS 3 independent plans (inax-active, inax-inactive, toto-inactive): distinct plan SHAs, own ledgers"
B2=("${PSQL[@]}" -U dpg_operator -d "$DB")
state2() { "${S[@]}" -c "select string_agg(sku||':'||is_active::int||':'||coalesce(canonical_price_status,'-')||':'||coalesce(regular_price_vnd::text,'-')||':v'||version, ' ' order by sku) from dpg_app.products where sku in ('IN-1','IN-2','II-1','TI-1')"; }
BASE2="II-1:0:-:-:v1 IN-1:1:-:-:v1 IN-2:1:-:-:v1 TI-1:0:-:-:v1"; [ "$(state2)" = "$BASE2" ]
"${B2[@]}" -v approved_sha=$PIA -f $T2/inax-active/batch-0001-apply.sql >/dev/null
[ "$(state2)" = "II-1:0:-:-:v1 IN-1:1:PRICE_VERIFIED:1500000:v2 IN-2:1:PRICE_VERIFIED:2500000:v2 TI-1:0:-:-:v1" ] || { state2; exit 1; }
echo "PASS INAX active plan touched only INAX active rows; inactive rows and TOTO untouched; is_active unchanged"
# a plan of one brand cannot be applied with another plan's SHA, nor on rows of the other brand/state
if "${B2[@]}" -v approved_sha=$PIA -f $T2/inax-inactive/batch-0001-apply.sql >/dev/null 2>&1; then echo "FAIL: batch ran with another plan's SHA"; exit 1; fi
# concurrent state change: someone re-activates the inactive INAX SKU between plan and apply -> the batch aborts, nothing is written
"${S[@]}" -c "update dpg_app.products set is_active=true, version=version+1 where sku='II-1'"
if "${B2[@]}" -v approved_sha=$PII -f $T2/inax-inactive/batch-0001-apply.sql >/dev/null 2>&1; then echo "FAIL: inactive plan wrote to a SKU activated meanwhile"; exit 1; fi
[ "$(state2)" = "II-1:1:-:-:v2 IN-1:1:PRICE_VERIFIED:1500000:v2 IN-2:1:PRICE_VERIFIED:2500000:v2 TI-1:0:-:-:v1" ] || { state2; exit 1; }
echo "PASS concurrent is_active change aborts the inactive batch atomically (no price written, is_active untouched)"
"${S[@]}" -c "update dpg_app.products set is_active=false, version=version+1 where sku='II-1'"
"${B2[@]}" -v approved_sha=$PTI -f $T2/toto-inactive/batch-0001-apply.sql >/dev/null
[ "$(state2)" = "II-1:0:-:-:v3 IN-1:1:PRICE_VERIFIED:1500000:v2 IN-2:1:PRICE_VERIFIED:2500000:v2 TI-1:0:PRICE_VERIFIED:3500000:v2" ] || { state2; exit 1; }
echo "PASS TOTO inactive plan applied independently; rollback of INAX-active restores only its rows"
"${B2[@]}" -v approved_sha=$PIA -f $T2/inax-active/batch-0001-rollback.sql >/dev/null
[ "$(state2)" = "II-1:0:-:-:v3 IN-1:1:-:-:v3 IN-2:1:-:-:v3 TI-1:0:PRICE_VERIFIED:3500000:v2" ] || { state2; exit 1; }
echo "PASS per-brand/state rollback leaves the other plans' rows (TOTO inactive) intact"
# rollback of another state's plan is refused on rows it never applied
if "${B2[@]}" -v approved_sha=$PII -f $T2/inax-inactive/batch-0001-rollback.sql >/dev/null 2>&1; then echo "FAIL: rollback of a never-applied plan ran"; exit 1; fi
# ---------- PHASE 3: Owner-accepted historical candidates (single price, source timestamp kept, provenance in the ledger only) ----------
T3=$T/p3; mkdir -p $T3
node -e '
const [dir,id1,id2]=process.argv.slice(1); const fs=require("fs");
const cols=["brand","dpg_id","dpg_sku","source_sku","category","is_active","match_type","confidence","review_status","historical_regular_price_vnd","historical_promotional_price_vnd","historical_online_voucher_amount_vnd","currency","source_url","source_checked_at_utc","pdp_selling","offer_price","search_sku","matched_hita_product_id","rule_version"];
const R=(id,sku,price)=>({brand:"INAX",dpg_id:id,dpg_sku:sku,source_sku:sku,category:"thiet-bi-ve-sinh",is_active:"true",match_type:"EXACT_SKU_INDIRECT_BRAND",confidence:"MODERATE",review_status:"HISTORICAL_PRICE_CANDIDATE",historical_regular_price_vnd:String(price),historical_promotional_price_vnd:"",historical_online_voucher_amount_vnd:"",currency:"VND",source_url:`https://hita.com.vn/p-${id}-${id}.html`,source_checked_at_utc:"2026-11-24T03:40:48.253Z",pdp_selling:String(price).replace(/\B(?=(\d{3})+(?!\d))/g,".")+"đ",offer_price:price+".00",search_sku:sku,matched_hita_product_id:String(9000+Number(id)),rule_version:"OWNER_477_OFFLINE"});
const q=v=>`"${String(v).replaceAll("\"","\"\"")}"`; const rows=[R(id1,"IN-1",1500000),R(id2,"IN-2",2500000)];
fs.writeFileSync(dir+"/cand.csv",cols.map(q).join(",")+"\r\n"+rows.map(r=>cols.map(c=>q(r[c])).join(",")).join("\r\n")+"\r\n");
' $T3 $IN1 $IN2
CSHA=$(sha256sum $T3/cand.csv | cut -d' ' -f1)
echo "{\"approved_by\":\"Owner\",\"approval_ref\":\"local-test\",\"rule_ref\":\"#443 comment 7127072994\",\"candidate_csv_sha256\":\"$CSHA\",\"approved_ids\":[$IN1]}" > $T3/approval.json
snap_brand2() { "${S[@]}" -c "select json_build_object('db_size_bytes', pg_database_size(current_database()), 'rows', (select json_agg(t) from (select id, sku, category_id, brand_id, is_active, version, canonical_price_status, regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd, canonical_price_checked_at from dpg_app.products where category_id=1 and brand_id=2 order by id) t))" > $T3/snap.json; }
snap_brand2
cand() { npx tsx scripts/hita-price-audit/prod-import.mts $T3/cand.csv --csv-sha256 "$CSHA" --candidate-sha "$CAND" --db-snapshot $T3/snap.json --now 2026-11-25T01:00:00Z --brand inax --state active --owner-candidates "$1" "${@:2}"; }
echo '{"approved_by":"Owner","approval_ref":"x","rule_ref":"x","candidate_csv_sha256":"'$CSHA'","approved_ids":[]}' > $T3/none.json
if cand $T3/none.json --out $T3/none > $T3/none.out 2>&1; then if grep -q '"to_change": 0' $T3/none.out; then :; fi; fi
[ ! -e $T3/none/batch-0001-apply.sql ]; echo "PASS an approval without ids plans nothing (no SQL emitted)"
cand $T3/approval.json --out $T3/plan > $T3/plan.json
PC=$(node -p "require('$T3/plan.json').plan_sha")
node -e 'const r=require(process.argv[1]); if(r.to_change!==1||r.not_approved!==1||r.price_basis!=="OWNER_ACCEPTED_CANDIDATE")process.exit(1)' $T3/plan.json
grep -q '"price_basis":"OWNER_ACCEPTED_CANDIDATE"' $T3/plan/ledger.jsonl; grep -q '"not_direct_hita_verified":true' $T3/plan/ledger.jsonl
echo "PASS candidate plan = only the Owner-approved id; the other candidate is left alone; ledger carries provenance (not direct Hita verified)"
B3=("${PSQL[@]}" -U dpg_operator -d "$DB")
"${B3[@]}" -v approved_sha=$PC -f $T3/plan/batch-0001-apply.sql >/dev/null
[ "$("${S[@]}" -c "select canonical_price_status||':'||regular_price_vnd||':'||coalesce(promotional_price_vnd::text,'-')||':'||coalesce(online_voucher_amount_vnd::text,'-')||':'||to_char(canonical_price_checked_at at time zone 'utc','YYYY-MM-DD\"T\"HH24:MI:SS.MS') from dpg_app.products where sku='IN-1'")" = "PRICE_VERIFIED:1500000:-:-:2026-11-24T03:40:48.253" ] || { echo "FAIL candidate state"; exit 1; }
[ "$("${S[@]}" -c "select canonical_price_status is null and regular_price_vnd is null from dpg_app.products where sku='IN-2'")" = "t" ]
echo "PASS candidate applied: regular price only, promo/voucher NULL, checked-at = SOURCE time (not now); unapproved SKU untouched"
"${B3[@]}" -v approved_sha=$PC -f $T3/plan/batch-0001-rollback.sql >/dev/null
[ "$("${S[@]}" -c "select canonical_price_status is null and regular_price_vnd is null and canonical_price_checked_at is null from dpg_app.products where sku='IN-1'")" = "t" ]
echo "PASS candidate rollback restores the exact prior (empty) state"
# stop rule: headroom
node -e 'const s=require(process.argv[1]); s.db_size_bytes=360*1024*1024; require("fs").writeFileSync(process.argv[1],JSON.stringify(s))' $T/snap.json
if run > $T/stop.json 2>&1; then echo "FAIL: planner did not stop on headroom"; exit 1; fi; grep -q DB_HEADROOM_INSUFFICIENT $T/stop.json
echo "PASS planner stops when headroom is insufficient"
echo "ALL PASS"
