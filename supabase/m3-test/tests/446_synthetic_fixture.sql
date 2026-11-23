-- #446 synthetic fixture (isolated local PostgreSQL only; never run on a hosted project).
create role dpg_admin_api_test nologin; create role dpg_order_intake_function_owner nologin;
create schema dpg_control; create schema dpg_app;
create table dpg_control.target_contract(environment text, production_writes_allowed bool, production_data_allowed bool, production_credentials_allowed bool);
insert into dpg_control.target_contract values ('preview_synthetic', false, false, false);
create function dpg_control.phase2_preview_synthetic_product_eligible(int) returns bool language sql as 'select false';
create function dpg_app.runtime_key_hash(text) returns char(64) language sql as $$select md5($1)||md5($1)$$;
create function dpg_app.runtime_hash(jsonb) returns char(64) language sql as $$select md5($1::text)||md5($1::text)$$;
create table dpg_app.categories(id serial primary key, slug text unique);
insert into dpg_app.categories(slug) values ('gach-op-lat'),('thiet-bi-ve-sinh');
create table dpg_app.products(id int primary key, sku text, name text, category_id int, price numeric, original_price numeric, list_price numeric, sale_price numeric,
  online_discount_amount numeric, stock_status text, price_source text, source_system text, price_state text, price_confidence text, price_updated_at timestamptz,
  is_active bool default true, publication_status text default 'public', pdp_visibility text default 'public', sellable_status text default 'sellable');
create sequence dpg_app.orders_id_seq;
create table dpg_app.orders(id int primary key, owner_id int, order_number varchar(20), customer_name text, customer_phone text, customer_email text, customer_address text, note text,
  subtotal numeric, discount numeric, total numeric, status text, payment_status text, order_origin text, shipping_fee_status text);
create table dpg_app.order_items(id serial primary key, order_id int, product_id int, product_name text, product_sku text, quantity int, unit_price numeric, total_price numeric, commercial_snapshot jsonb);
create table dpg_app.guest_order_idempotency_records(key_hash char(64) primary key, request_hash char(64), safe_response jsonb);
create table dpg_app.guest_order_rate_limit_windows(phone_hash char(64), window_start timestamptz, request_count int, primary key(phone_hash, window_start));

