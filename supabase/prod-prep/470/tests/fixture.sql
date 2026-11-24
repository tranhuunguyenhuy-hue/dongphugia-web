-- #470 isolated fixture shaped like the live Production schema (read-only audit 2026-11-24). LOCAL POSTGRES ONLY.
create role dpg_migration nologin; create role dpg_operator login bypassrls; grant dpg_migration to dpg_operator;  -- Production: postgres (BYPASSRLS, non-superuser) inherits dpg_migration
 create role dpg_admin_api nologin; create role dpg_public_catalogue nologin; create role dpg_runtime nologin;
create role dpg_readonly nologin; create role authenticated nologin; create role dpg_direct_import nologin;
create schema dpg_control authorization dpg_migration; create schema dpg_app authorization dpg_migration;
grant usage on schema dpg_app, dpg_control to dpg_admin_api, dpg_public_catalogue, dpg_runtime, dpg_readonly, authenticated, dpg_direct_import;
grant usage on schema public to authenticated;
grant create on schema public to dpg_operator;
set role dpg_migration;
create table dpg_control.target_contract(singleton bool primary key default true, project_name text, region text, environment text, data_class text,
  production_data_allowed bool, production_credentials_allowed bool, production_writes_allowed bool, hard_database_ceiling_bytes bigint);
insert into dpg_control.target_contract values (true,'dongphugia-runtime','ap-southeast-1','preview','production-derived-reduced-runtime',true,false,true,367001600);
create table dpg_app.categories(id serial primary key, slug varchar(100) unique, name text, is_active bool default true);
insert into dpg_app.categories(slug,name) values ('thiet-bi-ve-sinh','VS'),('thiet-bi-bep','Bep'),('vat-lieu-nuoc','VLN'),('san-go','SG'),('gach-op-lat','Gach');
create table dpg_app.brands(id serial primary key, slug varchar(100) not null unique, name text);
insert into dpg_app.brands(slug,name) values ('toto','TOTO'),('inax','INAX');
create table dpg_app.products(
  id serial primary key, sku varchar(100) not null unique, name varchar(500) not null, slug varchar(500) not null, category_id int not null references dpg_app.categories(id), brand_id int references dpg_app.brands(id),
  price numeric(15,2), price_display varchar(50) default 'Liên hệ báo giá', stock_status varchar(20) not null default 'in_stock', is_active bool not null default true,
  original_price numeric(15,2), online_discount_amount numeric(15,2), publication_status varchar(30) not null default 'public', pdp_visibility varchar(30) not null default 'public',
  sale_status varchar(40) not null default 'available', price_state varchar(40) not null default 'unknown', list_price numeric(15,2), sale_price numeric(15,2),
  price_source varchar(40) not null default 'unknown', price_confidence varchar(40) not null default 'medium', price_updated_at timestamptz,
  sellable_status varchar(40) not null default 'sellable', version int not null default 1,
  constraint direct_parity_16 check (true), unique (category_id, slug));
alter table dpg_app.products enable row level security; alter table dpg_app.products force row level security;
create policy leo541_products_select_public on dpg_app.products for select to authenticated using (is_active and publication_status='public' and pdp_visibility='public' and sellable_status='sellable');
create policy leo538_runtime_select on dpg_app.products for select to dpg_runtime, dpg_readonly using (true);
create policy admin_api_all on dpg_app.products for all to dpg_admin_api using (true) with check (true);
create policy dpg_public_products_select on dpg_app.products for select to dpg_public_catalogue using (is_active);
alter table dpg_app.categories enable row level security; alter table dpg_app.categories force row level security;
create policy cat_runtime on dpg_app.categories for select to dpg_runtime, dpg_readonly using (true);
-- Production ACL shape: table-level SELECT for runtime readers + authenticated; column-level for public catalogue + admin API; NO grant on categories for authenticated.
grant select on dpg_app.products to dpg_runtime, dpg_readonly, authenticated; grant select on dpg_app.categories to dpg_runtime, dpg_readonly;
grant select (id, sku, name, slug, category_id, is_active, publication_status, pdp_visibility) on dpg_app.products to dpg_public_catalogue;
grant select, insert, update (name, price, original_price, list_price, sale_price, online_discount_amount, price_display, sellable_status, stock_status, is_active) on dpg_app.products to dpg_admin_api;
grant select (id, sku, price_state, version) on dpg_app.products to dpg_admin_api; grant update (version) on dpg_app.products to dpg_admin_api;
create function dpg_app.runtime_key_hash(text) returns char(64) language sql as $$select md5($1)||md5($1)$$;
create function dpg_app.runtime_hash(jsonb) returns char(64) language sql as $$select md5($1::text)||md5($1::text)$$;
create table dpg_app.runtime_idempotency_records(owner_id uuid, operation text, key_hash char(64), request_hash char(64), safe_response jsonb, resource_type text, resource_id text, expires_at timestamptz, primary key(owner_id, operation, key_hash));
create table dpg_app.runtime_audit_events(id bigserial primary key, owner_id uuid, actor_id uuid, operation text, resource_type text, resource_id text, request_id uuid, idempotency_key_hash char(64), changed_fields text[], metadata jsonb);
create sequence dpg_app.orders_id_seq; create sequence dpg_app.quote_requests_id_seq;
create table dpg_app.orders(id int primary key, order_number varchar(20) not null, customer_name varchar not null, customer_phone varchar not null, customer_email varchar, customer_address text, note text,
  subtotal numeric not null default 0, shipping_fee numeric not null default 0, total numeric not null default 0, status varchar not null, payment_method varchar, payment_status varchar not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), discount numeric not null default 0, vat_rate int not null default 0, owner_id uuid);
create table dpg_app.order_items(id serial primary key, order_id int not null, product_id int not null, product_name varchar not null, product_sku varchar not null, quantity int not null, unit_price numeric not null, total_price numeric not null, created_at timestamptz not null default now());
create table dpg_app.quote_requests(id int primary key, name varchar not null, phone varchar not null, email varchar, message text, status varchar not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  quote_number varchar, shipping_fee numeric not null default 0, vat_rate int not null default 0, owner_id uuid);
create table dpg_app.quote_items(id serial primary key, quote_id int not null, product_id int not null, quantity int not null, note varchar, created_at timestamptz not null default now(), admin_quantity int, admin_unit_price numeric,
  product_sku_snapshot varchar, product_name_snapshot varchar, commerce_mode_snapshot varchar, availability_snapshot varchar, list_price_snapshot numeric, sale_price_snapshot numeric, snapshot_at timestamptz);
grant select, insert, update, delete on dpg_app.orders, dpg_app.order_items, dpg_app.quote_requests, dpg_app.quote_items, dpg_app.runtime_idempotency_records, dpg_app.runtime_audit_events to authenticated;
grant usage on all sequences in schema dpg_app to authenticated;
grant select on dpg_control.target_contract to authenticated;
reset role;
