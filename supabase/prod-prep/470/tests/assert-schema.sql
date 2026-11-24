create function pg_temp.assert(cond bool, msg text) returns void language plpgsql as $$ begin if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if; end $$;
create function pg_temp.rejects(stmt text, msg text) returns void language plpgsql as $$
begin begin execute stmt; exception when check_violation or insufficient_privilege then return; end; raise exception 'ASSERT FAILED (accepted): %', msg; end $$;
select pg_temp.assert((select count(*) from information_schema.columns where table_schema='dpg_app' and table_name='products' and column_name in ('regular_price_vnd','promotional_price_vnd','online_voucher_amount_vnd','canonical_price_status','canonical_price_checked_at'))=5,'5 columns');
select pg_temp.assert((select count(*) from dpg_app.products where regular_price_vnd is not null or canonical_price_status is not null)=0,'all new columns NULL after DDL (no data change)');
-- CHECK matrix
select pg_temp.rejects($$update dpg_app.products set canonical_price_status='PRICE_VERIFIED' where sku='VS-OK'$$,'PRICE_VERIFIED without regular');
select pg_temp.rejects($$update dpg_app.products set canonical_price_status='CONTACT_VERIFIED', regular_price_vnd=5 where sku='VS-OK'$$,'price on CONTACT_VERIFIED');
select pg_temp.rejects($$update dpg_app.products set canonical_price_status='UNRESOLVED', regular_price_vnd=5 where sku='VS-OK'$$,'price on UNRESOLVED');
select pg_temp.rejects($$update dpg_app.products set regular_price_vnd=5 where sku='VS-OK'$$,'price with NULL status');
select pg_temp.rejects($$update dpg_app.products set canonical_price_status='MAYBE' where sku='VS-OK'$$,'unknown status');
select pg_temp.rejects($$update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=100, promotional_price_vnd=100 where sku='VS-OK'$$,'promo >= regular');
select pg_temp.rejects($$update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=100, promotional_price_vnd=90, online_voucher_amount_vnd=90 where sku='VS-OK'$$,'voucher >= selling');
select pg_temp.rejects($$update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=100, online_voucher_amount_vnd=100 where sku='VS-OK'$$,'voucher >= regular');
select pg_temp.rejects($$update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=0 where sku='VS-OK'$$,'regular 0');
select pg_temp.rejects($$update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=10000000000000 where sku='VS-OK'$$,'regular too large');
update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=100, promotional_price_vnd=90, online_voucher_amount_vnd=10 where sku='VS-OK';
select pg_temp.rejects($$update dpg_app.products set canonical_price_status='CONTACT_VERIFIED' where sku='VS-OK'$$,'status change keeping prices');
update dpg_app.products set canonical_price_status=null, regular_price_vnd=null, promotional_price_vnd=null, online_voucher_amount_vnd=null where sku='VS-OK';
-- column ACL
select pg_temp.assert(has_column_privilege('dpg_public_catalogue','dpg_app.products','regular_price_vnd','SELECT'),'public reads canonical price');
select pg_temp.assert(has_column_privilege('dpg_public_catalogue','dpg_app.products','canonical_price_status','SELECT'),'public reads status');
select pg_temp.assert(not has_column_privilege('dpg_public_catalogue','dpg_app.products','canonical_price_checked_at','SELECT'),'public cannot read checked_at');
select pg_temp.assert(not has_column_privilege('dpg_public_catalogue','dpg_app.products','price','SELECT'),'public still cannot read legacy price');
select pg_temp.assert(not has_column_privilege('dpg_public_catalogue','dpg_app.products','regular_price_vnd','UPDATE'),'public cannot write');
select pg_temp.assert(has_column_privilege('dpg_admin_api','dpg_app.products','regular_price_vnd','UPDATE'),'admin writes price');
select pg_temp.assert(has_column_privilege('dpg_admin_api','dpg_app.products','canonical_price_status','UPDATE'),'admin writes status');
select pg_temp.assert(has_column_privilege('authenticated','dpg_app.products','regular_price_vnd','SELECT'),'authenticated (table-level) reads');
select pg_temp.assert(has_column_privilege('dpg_runtime','dpg_app.products','canonical_price_status','SELECT'),'runtime reads');
select pg_temp.assert(not has_column_privilege('dpg_direct_import','dpg_app.products','regular_price_vnd','UPDATE'),'direct_import has no new write');
select pg_temp.assert(not has_table_privilege('authenticated','dpg_app.categories','SELECT'),'fixture matches Production: authenticated cannot read categories');
