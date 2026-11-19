-- M5 PRODUCTION (project bonxyxluzlxfkdetryoo): conditional rollback of 002_cdn_normalization.sql.
-- Restores a field ONLY if its current value is still exactly what 002 wrote (md5 equal to the ledger's new_md5) AND the
-- reverse origin substitution reproduces the original byte-for-byte (md5 equal to old_md5). Anything edited since (by the
-- Admin or a later upload) is left untouched and reported. products.version + 1 once per restored product.
-- Reverse is exact because 002 only rewrote HTML/JSON rows that contained no new-origin URL before.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';
do $$ begin
  if not exists (select 1 from dpg_control.target_contract where project_name = 'dongphugia-runtime')
     or (select count(*) from dpg_app.products) < 17000 then
    raise exception 'M5_CDN_ROLLBACK_GUARD_FAILED: not the Production project';
  end if;
end $$;

create function pg_temp.m5_col_back(v text) returns text language sql immutable as
  $f$ select regexp_replace(v, '^https://dpg-products\.b-cdn\.net/', 'https://cdn.dongphugia.com.vn/') $f$;
create function pg_temp.m5_doc_back(v text) returns text language sql immutable as
  $f$ select replace(replace(v, '"https://dpg-products.b-cdn.net/', '"https://cdn.dongphugia.com.vn/'),
                     '''https://dpg-products.b-cdn.net/', '''https://cdn.dongphugia.com.vn/') $f$;
create temp table m5_restored (tbl text, pk integer, col text, product_id integer) on commit drop;

with r as (select t.id, l.product_id from dpg_control.m5_cdn_ledger l join dpg_app.product_images t on t.id = l.pk
           where l.tbl = 'product_images' and l.col = 'image_url' and l.rolled_back_at is null
             and md5(t.image_url)::uuid = l.new_md5 and md5(pg_temp.m5_col_back(t.image_url))::uuid = l.old_md5 for update of t),
u as (update dpg_app.product_images t set image_url = pg_temp.m5_col_back(t.image_url) from r where t.id = r.id returning t.id, r.product_id)
insert into m5_restored select 'product_images', id, 'image_url', product_id from u;

with r as (select t.id, l.product_id from dpg_control.m5_cdn_ledger l join dpg_app.product_documents t on t.id = l.pk
           where l.tbl = 'product_documents' and l.col = 'url' and l.rolled_back_at is null
             and md5(t.url)::uuid = l.new_md5 and md5(pg_temp.m5_col_back(t.url))::uuid = l.old_md5 for update of t),
u as (update dpg_app.product_documents t set url = pg_temp.m5_col_back(t.url) from r where t.id = r.id returning t.id, r.product_id)
insert into m5_restored select 'product_documents', id, 'url', product_id from u;

with r as (select t.id, l.product_id from dpg_control.m5_cdn_ledger l join dpg_app.product_descriptions t on t.id = l.pk
           where l.tbl = 'product_descriptions' and l.col = 'clean_html' and l.rolled_back_at is null
             and md5(t.clean_html)::uuid = l.new_md5 and md5(pg_temp.m5_doc_back(t.clean_html))::uuid = l.old_md5 for update of t),
u as (update dpg_app.product_descriptions t set clean_html = pg_temp.m5_doc_back(t.clean_html) from r where t.id = r.id returning t.id, r.product_id)
insert into m5_restored select 'product_descriptions', id, 'clean_html', product_id from u;

with r as (select t.id from dpg_control.m5_cdn_ledger l join dpg_app.products t on t.id = l.pk
           where l.tbl = 'products' and l.col = 'image_main_url' and l.rolled_back_at is null
             and md5(t.image_main_url)::uuid = l.new_md5 and md5(pg_temp.m5_col_back(t.image_main_url))::uuid = l.old_md5 for update of t),
u as (update dpg_app.products t set image_main_url = pg_temp.m5_col_back(t.image_main_url) from r where t.id = r.id returning t.id)
insert into m5_restored select 'products', id, 'image_main_url', id from u;

with r as (select t.id from dpg_control.m5_cdn_ledger l join dpg_app.products t on t.id = l.pk
           where l.tbl = 'products' and l.col = 'description' and l.rolled_back_at is null
             and md5(t.description)::uuid = l.new_md5 and md5(pg_temp.m5_doc_back(t.description))::uuid = l.old_md5 for update of t),
u as (update dpg_app.products t set description = pg_temp.m5_doc_back(t.description) from r where t.id = r.id returning t.id)
insert into m5_restored select 'products', id, 'description', id from u;

with r as (select t.id from dpg_control.m5_cdn_ledger l join dpg_app.products t on t.id = l.pk
           where l.tbl = 'products' and l.col = 'specs' and l.rolled_back_at is null
             and md5(t.specs::text)::uuid = l.new_md5 and md5(pg_temp.m5_doc_back(t.specs::text)::jsonb::text)::uuid = l.old_md5 for update of t),
u as (update dpg_app.products t set specs = pg_temp.m5_doc_back(t.specs::text)::jsonb from r where t.id = r.id returning t.id)
insert into m5_restored select 'products', id, 'specs', id from u;

update dpg_app.products p set version = p.version + 1 where p.id in (select distinct product_id from m5_restored where product_id is not null);
update dpg_control.m5_cdn_ledger l set rolled_back_at = now() from m5_restored r where l.tbl = r.tbl and l.pk = r.pk and l.col = r.col;

select 'restored' as kind, tbl || '.' || col as field, count(*) as n from m5_restored group by 2
union all select 'skipped_changed_since', tbl || '.' || col, count(*) from dpg_control.m5_cdn_ledger where rolled_back_at is null group by 2
order by 1, 2;
commit;
