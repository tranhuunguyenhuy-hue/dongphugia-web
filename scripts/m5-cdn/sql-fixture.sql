-- Local/CI fixture for 002/003 (synthetic rows only). Mirrors the columns and the statement trigger of Production.
drop schema if exists dpg_app cascade; drop schema if exists dpg_control cascade; drop table if exists snapshot;
create schema dpg_app; create schema dpg_control;
create table dpg_control.target_contract (project_name text, production_writes_allowed boolean);
insert into dpg_control.target_contract values ('dongphugia-runtime', true);
create table dpg_app.products (id serial primary key, sku text, slug text, image_main_url varchar(1000), description text, specs jsonb, version integer not null default 1, updated_at timestamptz default '2026-01-01');
create table dpg_app.product_images (id serial primary key, product_id integer, image_url varchar(1000), alt_text text);
create table dpg_app.product_documents (id serial primary key, product_id integer, name text, url varchar(1000));
create table dpg_app.product_descriptions (id serial primary key, product_id integer, raw_html text, clean_html text);
create table dpg_app.blog_posts (id serial primary key, thumbnail_url text, cover_image_url text, content text, version integer default 1);
insert into dpg_app.products (sku, slug, image_main_url) select 'S' || g, 's-' || g, 'https://other.example/x' || g || '.jpg' from generate_series(1, 17000) g;
-- Representative cases (ids 1..9):
update dpg_app.products set image_main_url = 'https://cdn.dongphugia.com.vn/migrated/toto/A-1.JPG', description = '<p><img src="https://cdn.dongphugia.com.vn/migrated/toto/a b%20c.jpg" alt=''x''><a href=''https://cdn.dongphugia.com.vn/product_docs/d.pdf''>d</a> https://cdn.dongphugia.com.vn.evil.example/ </p>', specs = '{"docs": [{"url": "https://cdn.dongphugia.com.vn/documents/toto/x.pdf", "name": "Hướng dẫn"}], "k": "https://cdn.dongphugia.com.vnx/"}' where id = 1;
update dpg_app.products set image_main_url = 'https://cdn.dongphugia.com.vn/products/gach-op-lat/36GP0880.jpg' where id = 2;           -- excluded (missing object)
update dpg_app.products set image_main_url = 'http://cdn.dongphugia.com.vn/x.jpg', description = '<img src="https://CDN.dongphugia.com.vn/y.jpg">' where id = 3; -- not the exact origin: untouched
update dpg_app.products set description = '<img src="https://cdn.dongphugia.com.vn/a.jpg"><img src="https://dpg-products.b-cdn.net/b.jpg">' where id = 4; -- mixed: skipped
update dpg_app.products set description = 'text https://cdn.dongphugia.com.vn/unquoted.jpg' where id = 5; -- unanchored: skipped
update dpg_app.products set description = '<img src="https://cdn.dongphugia.com.vn/products/gach-op-lat/36GP0880.jpg">' where id = 6; -- contains excluded: skipped
insert into dpg_app.product_images (product_id, image_url) values
  (1, 'https://cdn.dongphugia.com.vn/migrated/toto/A-1.JPG'), (1, 'https://cdn.dongphugia.com.vn/products//ckfinder/B%E1%BB%93n.png'),
  (7, 'https://cdn.dongphugia.com.vn/hita/h.png'), (2, 'https://cdn.dongphugia.com.vn/products/gach-op-lat/36GP0880.jpg'),
  (8, 'https://dpg-products.b-cdn.net/blog/1.webp'), (9, 'https://cdn.dongphugia.com.vn/hita/edited-later.png');
insert into dpg_app.product_documents (product_id, name, url) values (1, 'd', 'https://cdn.dongphugia.com.vn/product_docs/d.pdf');
insert into dpg_app.product_descriptions (product_id, clean_html) values (1, '<img src="https://cdn.dongphugia.com.vn/description_assets/q.png">'), (7, '<p>none</p>');
insert into dpg_app.blog_posts (thumbnail_url, content) values ('https://cdn.dongphugia.com.vn/blog/1782900856082-07fw89.png', '<img src="https://cdn.dongphugia.com.vn/blog/x.png">');
create function dpg_control.enforce_free_tier_headroom_statement() returns trigger language plpgsql as $$ begin if pg_database_size(current_database()) > 367001600 then raise exception 'hard stop'; end if; return null; end $$;
do $$ declare t text; begin foreach t in array array['products','product_images','product_documents','product_descriptions','blog_posts'] loop
  execute format('create trigger leo538_free_tier_headroom after insert or update on dpg_app.%I for each statement execute function dpg_control.enforce_free_tier_headroom_statement()', t); end loop; end $$;
create table snapshot as
  select 'p' k, id, md5(concat_ws('|', image_main_url, description, specs::text)) h from dpg_app.products
  union all select 'i', id, md5(image_url) from dpg_app.product_images
  union all select 'd', id, md5(url) from dpg_app.product_documents
  union all select 's', id, md5(clean_html) from dpg_app.product_descriptions
  union all select 'b', id, md5(concat_ws('|', thumbnail_url, cover_image_url, content)) from dpg_app.blog_posts;
