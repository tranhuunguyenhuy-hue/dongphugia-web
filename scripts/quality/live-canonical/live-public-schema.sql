-- #470 isolated fixture: the dpg_app tables the live Public read path touches, with the REAL Production column ACLs of
-- dpg_public_catalogue (read-only audit 2026-11-24) and its real RLS policies. LOCAL/CI POSTGRES ONLY.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'dpg_public_catalogue') then create role dpg_public_catalogue nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'dpg_admin_api') then create role dpg_admin_api nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'dpg_runtime') then create role dpg_runtime nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'dpg_operator470') then create role dpg_operator470 nologin bypassrls; end if;
end $$;
create schema dpg_control; create schema dpg_app;
grant usage on schema dpg_app to dpg_public_catalogue, dpg_admin_api, dpg_runtime, dpg_operator470;
create table dpg_control.target_contract(singleton bool primary key default true, project_name text, region text, environment text, data_class text,
  production_data_allowed bool, production_credentials_allowed bool, production_writes_allowed bool, hard_database_ceiling_bytes bigint);
insert into dpg_control.target_contract values (true,'dongphugia-runtime','ap-southeast-1','preview','production-derived-reduced-runtime',true,false,true,367001600);
create table dpg_app.categories(id serial primary key, slug varchar(100) not null unique, name varchar(200) not null, is_active bool not null default true);
create table dpg_app.subcategories(id serial primary key, category_id int not null references dpg_app.categories(id), slug varchar(100) not null, name varchar(200) not null, is_active bool not null default true, unique(category_id, slug));
create table dpg_app.brands(id serial primary key, slug varchar(100) not null unique, name varchar(200) not null, is_active bool not null default true);
create table dpg_app.spec_definitions(id serial primary key, key varchar(120) not null unique, label varchar(200) not null, is_pdp_visible bool not null default true, sort_order int not null default 0);
create table dpg_app.spec_options(id serial primary key, spec_definition_id int not null references dpg_app.spec_definitions(id), value varchar(200) not null, slug varchar(200), sort_order int not null default 0, is_active bool not null default true);
create table dpg_app.products(
  id serial primary key, sku varchar(100) not null unique, name varchar(500) not null, slug varchar(500) not null, category_id int not null references dpg_app.categories(id),
  subcategory_id int references dpg_app.subcategories(id), brand_id int references dpg_app.brands(id), description text, image_main_url varchar(1000),
  is_active bool not null default true, is_featured bool not null default false, sort_order int not null default 0, display_name varchar(500),
  variant_group varchar(50), variant_type varchar(30), variant_label varchar(100),
  publication_status varchar(30) not null default 'public', pdp_visibility varchar(30) not null default 'public', listing_visibility varchar(30) not null default 'default',
  search_visibility varchar(30) not null default 'visible', listing_priority int not null default 0,
  price numeric(15,2), original_price numeric(15,2), list_price numeric(15,2), sale_price numeric(15,2), online_discount_amount numeric(15,2),
  price_state varchar(40) not null default 'unknown', stock_status varchar(20) not null default 'in_stock', sellable_status varchar(40) not null default 'sellable',
  version int not null default 1, unique(category_id, slug),
  constraint direct_parity_16 check (true));
create table dpg_app.product_images(id serial primary key, product_id int not null references dpg_app.products(id), image_url text, sort_order int default 0);
create table dpg_app.product_descriptions(id serial primary key, product_id int not null references dpg_app.products(id), clean_html text, updated_at timestamptz default now());
create table dpg_app.product_spec_values(id serial primary key, product_id int not null references dpg_app.products(id), spec_definition_id int not null references dpg_app.spec_definitions(id), option_id int, value_text text, value_number numeric, value_json jsonb, raw_value text, sort_order int default 0);
create table dpg_app.product_documents(id serial primary key, product_id int not null references dpg_app.products(id), name text, url text, document_type text, file_size int, sort_order int default 0);
create table dpg_app.product_features(id serial primary key, name text, sort_order int default 0);
create table dpg_app.product_feature_values(product_id int not null references dpg_app.products(id), feature_id int not null references dpg_app.product_features(id));
create index products_listing_idx on dpg_app.products(category_id, subcategory_id, is_active);
create index products_brand_idx on dpg_app.products(brand_id);
create index products_search_trgm_unused on dpg_app.products(lower(sku));
-- Production ACL of dpg_public_catalogue (verbatim from the read-only audit)
grant select (id,sku,name,slug,category_id,subcategory_id,brand_id,description,image_main_url,is_active,is_featured,sort_order,display_name,variant_group,variant_type,variant_label,publication_status,pdp_visibility,listing_visibility,search_visibility,listing_priority) on dpg_app.products to dpg_public_catalogue;
grant select (id,name,slug,is_active) on dpg_app.brands, dpg_app.categories to dpg_public_catalogue;
grant select (id,category_id,name,slug,is_active) on dpg_app.subcategories to dpg_public_catalogue;
grant select (id,product_id,clean_html,updated_at) on dpg_app.product_descriptions to dpg_public_catalogue;
grant select (id,product_id,name,url,document_type,file_size,sort_order) on dpg_app.product_documents to dpg_public_catalogue;
grant select (product_id,feature_id) on dpg_app.product_feature_values to dpg_public_catalogue;
grant select (id,name,sort_order) on dpg_app.product_features to dpg_public_catalogue;
grant select (id,product_id,image_url,sort_order) on dpg_app.product_images to dpg_public_catalogue;
grant select (id,product_id,spec_definition_id,option_id,value_text,value_number,value_json,raw_value,sort_order) on dpg_app.product_spec_values to dpg_public_catalogue;
grant select (id,label,is_pdp_visible,sort_order) on dpg_app.spec_definitions to dpg_public_catalogue;
grant select (id,spec_definition_id,value,is_active) on dpg_app.spec_options to dpg_public_catalogue;
-- Real RLS policies for the public role
alter table dpg_app.products enable row level security; alter table dpg_app.products force row level security;
alter table dpg_app.categories enable row level security; alter table dpg_app.categories force row level security;
create policy dpg_public_products_select on dpg_app.products for select to dpg_public_catalogue using ((is_active = true) AND ((publication_status)::text = 'public') AND ((pdp_visibility)::text = 'public') AND (id > 0) AND ((name)::text <> '') AND (char_length((name)::text) <= 240) AND ((sku)::text <> '') AND (char_length((sku)::text) <= 120) AND ((slug)::text ~ '^[a-z0-9]+(-[a-z0-9]+)*$') AND (EXISTS (SELECT 1 FROM (dpg_app.categories c JOIN dpg_app.subcategories s ON ((s.category_id = c.id))) WHERE ((c.id = products.category_id) AND (s.id = products.subcategory_id) AND ((c.slug)::text = ANY (ARRAY['thiet-bi-ve-sinh','thiet-bi-bep','vat-lieu-nuoc','gach-op-lat'])) AND (c.is_active = true) AND (s.is_active = true)))));
create policy dpg_public_categories_select on dpg_app.categories for select to dpg_public_catalogue using ((is_active = true) AND ((slug)::text = ANY (ARRAY['thiet-bi-ve-sinh','thiet-bi-bep','vat-lieu-nuoc','gach-op-lat'])));
create policy admin_all on dpg_app.products for all to dpg_admin_api using (true) with check (true);
-- Admin API column ACL (price columns only; the rest is irrelevant to this test)
grant select (id,sku,name,slug,category_id,is_active,price,original_price,list_price,sale_price,version) on dpg_app.products to dpg_admin_api;
grant update (price,original_price,list_price,sale_price,version,name) on dpg_app.products to dpg_admin_api;
create table dpg_app.orders(id int primary key); -- 001 only needs products + target_contract; kept for realism
