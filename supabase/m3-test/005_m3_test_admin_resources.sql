-- M3 TEST-only (project uybumsnyqpwcidjxmfsv): column-level grants + RLS for the Admin resources served by `admin-api`.
-- GENERATED from supabase/functions/admin-api/resources.ts by scripts/m3/generate-admin-resource-grants.mts - do not edit by hand.
-- Forward migration, idempotent (grants and policies are re-created), ALL-OR-NOTHING (one transaction).
-- Operator MUST verify the runner targets the intended project.
begin;
-- guard:begin
do $$ begin
  if not exists (select 1 from dpg_control.target_contract
      where environment='preview_synthetic' and data_class='synthetic-with-approved-public-fixtures'
        and production_data_allowed is false and production_credentials_allowed is false
        and production_writes_allowed is false) then
    raise exception 'M3_TEST_TARGET_GUARD_FAILED:contract';
  end if;
  if (select count(*) from pg_roles where rolname in ('dpg_admin_m3_test','dpg_public_m3_test')) <> 2 then
    raise exception 'M3_TEST_TARGET_GUARD_FAILED:roles';
  end if;
  if exists (select 1 from dpg_app.orders) or exists (select 1 from dpg_app.customers) then
    raise exception 'M3_TEST_TARGET_GUARD_FAILED:business_data_present';
  end if;
end $$;
-- guard:end

-- Preflight: every table/column/sequence referenced below must exist, otherwise nothing is applied.
do $$ declare missing text; begin
  select string_agg(w.t || '.' || w.c, ', ' order by w.t, w.c) into missing from (values ('admin_users','id'),('admin_users','email'),('admin_users','name'),('admin_users','username'),('admin_users','role'),('admin_users','is_active'),('admin_users','last_login_at'),('admin_users','password_hash'),('admin_users','updated_at'),('banners','id'),('banners','title'),('banners','image_url'),('banners','link_url'),('banners','is_active'),('banners','sort_order'),('banners','updated_at'),('blog_categories','id'),('blog_categories','name'),('blog_categories','slug'),('blog_categories','sort_order'),('blog_categories','is_active'),('blog_post_tags','post_id'),('blog_post_tags','tag_id'),('blog_posts','id'),('blog_posts','title'),('blog_posts','slug'),('blog_posts','category_id'),('blog_posts','status'),('blog_posts','excerpt'),('blog_posts','content'),('blog_posts','thumbnail_url'),('blog_posts','cover_image_url'),('blog_posts','author_name'),('blog_posts','author_avatar'),('blog_posts','reading_time'),('blog_posts','is_featured'),('blog_posts','is_pinned'),('blog_posts','seo_title'),('blog_posts','seo_description'),('blog_posts','seo_keywords'),('blog_posts','view_count'),('blog_posts','published_at'),('blog_posts','updated_at'),('blog_posts','version'),('blog_posts','publishing_identity_id'),('blog_posts','first_published_at'),('blog_posts','external_id'),('blog_posts','scheduled_for'),('blog_posts','scheduled_timezone'),('blog_posts','scheduled_version'),('blog_posts','schedule_blocked_code'),('blog_posts','schedule_blocked_at'),('blog_posts','schedule_last_attempt_at'),('blog_tags','id'),('blog_tags','name'),('blog_tags','slug'),('blog_tags','description'),('blog_tags','post_count'),('blog_tags','is_active'),('blog_tags','updated_at'),('brands','id'),('brands','name'),('brands','slug'),('brands','logo_url'),('brands','description'),('brands','origin_country'),('brands','website_url'),('brands','is_active'),('brands','is_featured'),('brands','sort_order'),('brands','updated_at'),('catalog_taxons','id'),('catalog_taxons','parent_id'),('catalog_taxons','name'),('catalog_taxons','slug'),('catalog_taxons','canonical_path'),('catalog_taxons','depth'),('catalog_taxons','sort_order'),('catalog_taxons','kind'),('catalog_taxons','status'),('catalog_taxons','is_active'),('catalog_taxons','is_indexable'),('catalog_taxons','is_listing_enabled'),('catalog_taxons','seo_title'),('catalog_taxons','seo_description'),('catalog_taxons','updated_at'),('categories','id'),('categories','name'),('categories','slug'),('categories','is_active'),('categories','sort_order'),('categories','banner_url'),('categories','updated_at'),('colors','id'),('colors','name'),('colors','slug'),('colors','hex_code'),('customers','id'),('customers','full_name'),('customers','phone'),('customers','email'),('customers','source'),('customers','notes'),('customers','last_interacted_at'),('customers','created_at'),('customers','updated_at'),('materials','id'),('materials','name'),('materials','slug'),('materials','sort_order'),('order_items','id'),('order_items','order_id'),('order_items','product_id'),('order_items','product_name'),('order_items','product_sku'),('order_items','quantity'),('order_items','unit_price'),('order_items','total_price'),('orders','id'),('orders','order_number'),('orders','customer_name'),('orders','customer_phone'),('orders','customer_email'),('orders','customer_address'),('orders','note'),('orders','subtotal'),('orders','shipping_fee'),('orders','discount'),('orders','vat_rate'),('orders','total'),('orders','status'),('orders','payment_method'),('orders','payment_status'),('orders','created_at'),('orders','updated_at'),('orders','assigned_to'),('orders','assigned_at'),('origins','id'),('origins','name'),('origins','slug'),('partners','id'),('partners','name'),('partners','slug'),('partners','logo_url'),('partners','description'),('partners','tier'),('partners','gradient_class'),('partners','link_url'),('partners','is_active'),('partners','sort_order'),('partners','updated_at'),('product_documents','id'),('product_documents','product_id'),('product_documents','name'),('product_documents','url'),('product_documents','source_url'),('product_documents','document_type'),('product_documents','file_ext'),('product_documents','file_size'),('product_documents','sort_order'),('product_images','id'),('product_images','product_id'),('product_images','image_url'),('product_images','alt_text'),('product_images','image_type'),('product_images','sort_order'),('product_relationships','id'),('product_relationships','parent_id'),('product_relationships','child_id'),('product_relationships','child_sku'),('product_relationships','relationship_type'),('product_relationships','component_type'),('product_relationships','quantity'),('product_relationships','sort_order'),('product_relationships','resolution_status'),('product_spec_values','id'),('product_spec_values','product_id'),('product_spec_values','spec_definition_id'),('product_spec_values','option_id'),('product_spec_values','value_text'),('product_spec_values','value_number'),('product_spec_values','value_json'),('product_spec_values','raw_key'),('product_spec_values','raw_value'),('product_spec_values','sort_order'),('product_spec_values','updated_at'),('product_sub_types','id'),('product_sub_types','product_type_id'),('product_sub_types','name'),('product_sub_types','slug'),('product_sub_types','sort_order'),('product_sub_types','is_active'),('product_taxon_assignments','id'),('product_taxon_assignments','product_id'),('product_taxon_assignments','taxon_id'),('product_taxon_assignments','is_primary'),('product_taxon_assignments','sort_order'),('product_taxon_assignments','updated_at'),('product_types','id'),('product_types','subcategory_id'),('product_types','name'),('product_types','slug'),('product_types','description'),('product_types','sort_order'),('product_types','is_active'),('product_types','filter_policy'),('product_types','updated_at'),('products','id'),('products','sku'),('products','name'),('products','display_name'),('products','slug'),('products','category_id'),('products','subcategory_id'),('products','brand_id'),('products','origin_id'),('products','color_id'),('products','material_id'),('products','product_type_id'),('products','product_sub_type_id'),('products','product_type'),('products','product_sub_type'),('products','price'),('products','price_display'),('products','original_price'),('products','list_price'),('products','sale_price'),('products','online_discount_amount'),('products','stock_status'),('products','warranty_months'),('products','image_main_url'),('products','description'),('products','features'),('products','specs'),('products','is_active'),('products','is_featured'),('products','is_home_featured'),('products','is_promotion'),('products','is_combo'),('products','is_master'),('products','sort_order'),('products','publication_status'),('products','pdp_visibility'),('products','listing_visibility'),('products','search_visibility'),('products','sellable_status'),('products','seo_indexing'),('products','sitemap_include'),('products','source_url'),('products','hita_product_id'),('products','seo_title'),('products','seo_description'),('products','updated_at'),('products','version'),('products','variant_group'),('projects','id'),('projects','title'),('projects','slug'),('projects','location'),('projects','thumbnail_url'),('projects','description'),('projects','category'),('projects','tags'),('projects','is_featured'),('projects','is_active'),('projects','sort_order'),('projects','updated_at'),('quote_items','id'),('quote_items','quote_id'),('quote_items','product_id'),('quote_items','quantity'),('quote_items','note'),('quote_items','admin_quantity'),('quote_items','admin_unit_price'),('quote_items','product_sku_snapshot'),('quote_items','product_name_snapshot'),('quote_items','snapshot_at'),('quote_items','list_price_snapshot'),('quote_items','sale_price_snapshot'),('quote_requests','id'),('quote_requests','quote_number'),('quote_requests','name'),('quote_requests','phone'),('quote_requests','email'),('quote_requests','message'),('quote_requests','status'),('quote_requests','created_at'),('quote_requests','updated_at'),('quote_requests','admin_notes'),('quote_requests','shipping_fee'),('quote_requests','vat_rate'),('quote_requests','assigned_to'),('quote_requests','customer_id'),('spec_definitions','id'),('spec_definitions','key'),('spec_definitions','label'),('spec_definitions','data_type'),('spec_definitions','unit'),('spec_definitions','is_filterable'),('spec_definitions','is_pdp_visible'),('spec_definitions','is_reserved'),('spec_definitions','sort_order'),('spec_definitions','normalize_rule'),('spec_definitions','updated_at'),('spec_options','id'),('spec_options','spec_definition_id'),('spec_options','value'),('spec_options','slug'),('spec_options','sort_order'),('spec_options','aliases'),('spec_options','is_active'),('subcategories','id'),('subcategories','name'),('subcategories','slug'),('subcategories','category_id'),('subcategories','sort_order'),('subcategories','is_active')) as w(t,c)
   where not exists (select 1 from information_schema.columns i where i.table_schema = 'dpg_app' and i.table_name = w.t and i.column_name = w.c);
  if missing is not null then raise exception 'ADMIN_SCHEMA_PREFLIGHT_FAILED:columns:%', missing; end if;
  select string_agg(w.s, ', ') into missing from (values ('admin_users_id_seq'),('banners_id_seq'),('blog_posts_id_seq'),('blog_tags_id_seq'),('brands_id_seq'),('catalog_taxons_id_seq'),('customers_id_seq'),('partners_id_seq'),('product_documents_id_seq'),('product_images_id_seq'),('product_relationships_id_seq'),('product_spec_values_id_seq'),('product_sub_types_id_seq'),('product_taxon_assignments_id_seq'),('product_types_id_seq'),('products_id_seq'),('projects_id_seq'),('spec_definitions_id_seq'),('spec_options_id_seq')) as w(s)
   where w.s <> '' and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dpg_app' and c.relkind = 'S' and c.relname = w.s);
  if missing is not null then raise exception 'ADMIN_SCHEMA_PREFLIGHT_FAILED:sequences:%', missing; end if;
end $$;

grant usage on schema dpg_app to dpg_admin_api_test;
-- admin_users
grant select (email, id, is_active, last_login_at, name, role, username) on dpg_app.admin_users to dpg_admin_api_test;
grant insert (email, is_active, name, password_hash, role, username) on dpg_app.admin_users to dpg_admin_api_test;
grant update (email, is_active, name, password_hash, role, updated_at, username) on dpg_app.admin_users to dpg_admin_api_test;
grant usage, select on sequence dpg_app.admin_users_id_seq to dpg_admin_api_test;
-- banners
grant select (id, image_url, is_active, link_url, sort_order, title) on dpg_app.banners to dpg_admin_api_test;
grant insert (image_url, is_active, link_url, sort_order, title) on dpg_app.banners to dpg_admin_api_test;
grant update (image_url, is_active, link_url, sort_order, title, updated_at) on dpg_app.banners to dpg_admin_api_test;
grant delete on dpg_app.banners to dpg_admin_api_test;
grant usage, select on sequence dpg_app.banners_id_seq to dpg_admin_api_test;
-- blog_categories
grant select (id, is_active, name, slug, sort_order) on dpg_app.blog_categories to dpg_admin_api_test;
-- blog_post_tags
grant select (post_id, tag_id) on dpg_app.blog_post_tags to dpg_admin_api_test;
grant insert (post_id, tag_id) on dpg_app.blog_post_tags to dpg_admin_api_test;
grant delete on dpg_app.blog_post_tags to dpg_admin_api_test;
-- blog_posts
grant select (author_avatar, author_name, category_id, content, cover_image_url, excerpt, external_id, first_published_at, id, is_featured, is_pinned, published_at, publishing_identity_id, reading_time, seo_description, seo_keywords, seo_title, slug, status, thumbnail_url, title, updated_at, version, view_count) on dpg_app.blog_posts to dpg_admin_api_test;
grant insert (author_avatar, author_name, category_id, content, cover_image_url, excerpt, first_published_at, is_featured, is_pinned, published_at, reading_time, seo_description, seo_keywords, seo_title, slug, status, thumbnail_url, title) on dpg_app.blog_posts to dpg_admin_api_test;
grant update (author_avatar, author_name, category_id, content, cover_image_url, excerpt, first_published_at, is_featured, is_pinned, published_at, reading_time, schedule_blocked_at, schedule_blocked_code, schedule_last_attempt_at, scheduled_for, scheduled_timezone, scheduled_version, seo_description, seo_keywords, seo_title, slug, status, thumbnail_url, title, updated_at, version) on dpg_app.blog_posts to dpg_admin_api_test;
grant delete on dpg_app.blog_posts to dpg_admin_api_test;
grant usage, select on sequence dpg_app.blog_posts_id_seq to dpg_admin_api_test;
-- blog_tags
grant select (description, id, is_active, name, post_count, slug) on dpg_app.blog_tags to dpg_admin_api_test;
grant insert (description, name, slug) on dpg_app.blog_tags to dpg_admin_api_test;
grant update (is_active, post_count, updated_at) on dpg_app.blog_tags to dpg_admin_api_test;
grant usage, select on sequence dpg_app.blog_tags_id_seq to dpg_admin_api_test;
-- brands
grant select (description, id, is_active, is_featured, logo_url, name, origin_country, slug, sort_order, website_url) on dpg_app.brands to dpg_admin_api_test;
grant insert (description, is_active, is_featured, logo_url, name, origin_country, slug, sort_order, website_url) on dpg_app.brands to dpg_admin_api_test;
grant update (description, is_active, is_featured, logo_url, name, origin_country, slug, sort_order, updated_at, website_url) on dpg_app.brands to dpg_admin_api_test;
grant usage, select on sequence dpg_app.brands_id_seq to dpg_admin_api_test;
-- catalog_taxons
grant select (canonical_path, depth, id, is_active, is_indexable, is_listing_enabled, kind, name, parent_id, seo_description, seo_title, slug, sort_order, status) on dpg_app.catalog_taxons to dpg_admin_api_test;
grant insert (canonical_path, depth, is_active, is_indexable, is_listing_enabled, kind, name, parent_id, seo_description, seo_title, slug, sort_order, status) on dpg_app.catalog_taxons to dpg_admin_api_test;
grant update (canonical_path, depth, is_active, is_indexable, is_listing_enabled, kind, name, parent_id, seo_description, seo_title, slug, sort_order, status, updated_at) on dpg_app.catalog_taxons to dpg_admin_api_test;
grant usage, select on sequence dpg_app.catalog_taxons_id_seq to dpg_admin_api_test;
-- categories
grant select (banner_url, id, is_active, name, slug, sort_order) on dpg_app.categories to dpg_admin_api_test;
grant update (banner_url, updated_at) on dpg_app.categories to dpg_admin_api_test;
-- colors
grant select (hex_code, id, name, slug) on dpg_app.colors to dpg_admin_api_test;
-- customers
grant select (created_at, email, full_name, id, last_interacted_at, notes, phone, source) on dpg_app.customers to dpg_admin_api_test;
grant insert (email, full_name, last_interacted_at, notes, phone, source) on dpg_app.customers to dpg_admin_api_test;
grant update (email, full_name, last_interacted_at, notes, phone, source, updated_at) on dpg_app.customers to dpg_admin_api_test;
grant usage, select on sequence dpg_app.customers_id_seq to dpg_admin_api_test;
-- materials
grant select (id, name, slug, sort_order) on dpg_app.materials to dpg_admin_api_test;
-- order_items
grant select (id, order_id, product_id, product_name, product_sku, quantity, total_price, unit_price) on dpg_app.order_items to dpg_admin_api_test;
grant update (quantity, total_price, unit_price) on dpg_app.order_items to dpg_admin_api_test;
-- orders
grant select (assigned_at, assigned_to, created_at, customer_address, customer_email, customer_name, customer_phone, discount, id, note, order_number, payment_method, payment_status, shipping_fee, status, subtotal, total, updated_at, vat_rate) on dpg_app.orders to dpg_admin_api_test;
grant update (assigned_at, assigned_to, discount, note, payment_status, shipping_fee, status, subtotal, total, updated_at, vat_rate) on dpg_app.orders to dpg_admin_api_test;
-- origins
grant select (id, name, slug) on dpg_app.origins to dpg_admin_api_test;
-- partners
grant select (description, gradient_class, id, is_active, link_url, logo_url, name, slug, sort_order, tier) on dpg_app.partners to dpg_admin_api_test;
grant insert (description, gradient_class, is_active, link_url, logo_url, name, slug, sort_order, tier) on dpg_app.partners to dpg_admin_api_test;
grant update (description, gradient_class, is_active, link_url, logo_url, name, sort_order, tier, updated_at) on dpg_app.partners to dpg_admin_api_test;
grant delete on dpg_app.partners to dpg_admin_api_test;
grant usage, select on sequence dpg_app.partners_id_seq to dpg_admin_api_test;
-- product_documents
grant select (document_type, file_ext, file_size, id, name, product_id, sort_order, source_url, url) on dpg_app.product_documents to dpg_admin_api_test;
grant insert (document_type, file_ext, file_size, name, product_id, sort_order, source_url, url) on dpg_app.product_documents to dpg_admin_api_test;
grant update (document_type, file_ext, file_size, name, sort_order, source_url, url) on dpg_app.product_documents to dpg_admin_api_test;
grant delete on dpg_app.product_documents to dpg_admin_api_test;
grant usage, select on sequence dpg_app.product_documents_id_seq to dpg_admin_api_test;
-- product_images
grant select (alt_text, id, image_type, image_url, product_id, sort_order) on dpg_app.product_images to dpg_admin_api_test;
grant insert (alt_text, image_type, image_url, product_id, sort_order) on dpg_app.product_images to dpg_admin_api_test;
grant update (alt_text, image_type, image_url, sort_order) on dpg_app.product_images to dpg_admin_api_test;
grant delete on dpg_app.product_images to dpg_admin_api_test;
grant usage, select on sequence dpg_app.product_images_id_seq to dpg_admin_api_test;
-- product_relationships
grant select (child_id, child_sku, component_type, id, parent_id, quantity, relationship_type, resolution_status, sort_order) on dpg_app.product_relationships to dpg_admin_api_test;
grant insert (child_id, child_sku, component_type, parent_id, quantity, relationship_type, sort_order) on dpg_app.product_relationships to dpg_admin_api_test;
grant update (child_id, child_sku, component_type, quantity, relationship_type, sort_order) on dpg_app.product_relationships to dpg_admin_api_test;
grant delete on dpg_app.product_relationships to dpg_admin_api_test;
grant usage, select on sequence dpg_app.product_relationships_id_seq to dpg_admin_api_test;
-- product_spec_values
grant select (id, option_id, product_id, raw_key, raw_value, sort_order, spec_definition_id, value_json, value_number, value_text) on dpg_app.product_spec_values to dpg_admin_api_test;
grant insert (option_id, product_id, raw_key, raw_value, sort_order, spec_definition_id, value_json, value_number, value_text) on dpg_app.product_spec_values to dpg_admin_api_test;
grant update (option_id, raw_key, raw_value, sort_order, spec_definition_id, updated_at, value_json, value_number, value_text) on dpg_app.product_spec_values to dpg_admin_api_test;
grant delete on dpg_app.product_spec_values to dpg_admin_api_test;
grant usage, select on sequence dpg_app.product_spec_values_id_seq to dpg_admin_api_test;
-- product_sub_types
grant select (id, is_active, name, product_type_id, slug, sort_order) on dpg_app.product_sub_types to dpg_admin_api_test;
grant insert (is_active, name, product_type_id, slug, sort_order) on dpg_app.product_sub_types to dpg_admin_api_test;
grant update (is_active, name, product_type_id, slug, sort_order) on dpg_app.product_sub_types to dpg_admin_api_test;
grant usage, select on sequence dpg_app.product_sub_types_id_seq to dpg_admin_api_test;
-- product_taxon_assignments
grant select (id, is_primary, product_id, sort_order, taxon_id) on dpg_app.product_taxon_assignments to dpg_admin_api_test;
grant insert (is_primary, product_id, sort_order, taxon_id) on dpg_app.product_taxon_assignments to dpg_admin_api_test;
grant update (is_primary, sort_order, taxon_id, updated_at) on dpg_app.product_taxon_assignments to dpg_admin_api_test;
grant delete on dpg_app.product_taxon_assignments to dpg_admin_api_test;
grant usage, select on sequence dpg_app.product_taxon_assignments_id_seq to dpg_admin_api_test;
-- product_types
grant select (description, filter_policy, id, is_active, name, slug, sort_order, subcategory_id) on dpg_app.product_types to dpg_admin_api_test;
grant insert (description, filter_policy, is_active, name, slug, sort_order, subcategory_id) on dpg_app.product_types to dpg_admin_api_test;
grant update (description, filter_policy, is_active, name, slug, sort_order, subcategory_id, updated_at) on dpg_app.product_types to dpg_admin_api_test;
grant usage, select on sequence dpg_app.product_types_id_seq to dpg_admin_api_test;
-- products
grant select (brand_id, category_id, color_id, description, display_name, features, hita_product_id, id, image_main_url, is_active, is_combo, is_featured, is_home_featured, is_master, is_promotion, list_price, listing_visibility, material_id, name, online_discount_amount, origin_id, original_price, pdp_visibility, price, price_display, product_sub_type, product_sub_type_id, product_type, product_type_id, publication_status, sale_price, search_visibility, sellable_status, seo_description, seo_indexing, seo_title, sitemap_include, sku, slug, sort_order, source_url, specs, stock_status, subcategory_id, updated_at, variant_group, version, warranty_months) on dpg_app.products to dpg_admin_api_test;
grant insert (brand_id, category_id, color_id, description, display_name, features, hita_product_id, image_main_url, is_active, is_combo, is_featured, is_home_featured, is_master, is_promotion, list_price, listing_visibility, material_id, name, online_discount_amount, origin_id, original_price, pdp_visibility, price, price_display, product_sub_type, product_sub_type_id, product_type, product_type_id, publication_status, sale_price, search_visibility, sellable_status, seo_description, seo_indexing, seo_title, sitemap_include, sku, slug, sort_order, source_url, specs, stock_status, subcategory_id, warranty_months) on dpg_app.products to dpg_admin_api_test;
grant update (brand_id, category_id, color_id, description, display_name, features, hita_product_id, image_main_url, is_active, is_combo, is_featured, is_home_featured, is_master, is_promotion, list_price, listing_visibility, material_id, name, online_discount_amount, origin_id, original_price, pdp_visibility, price, price_display, product_sub_type, product_sub_type_id, product_type, product_type_id, publication_status, sale_price, search_visibility, sellable_status, seo_description, seo_indexing, seo_title, sitemap_include, sort_order, source_url, specs, stock_status, subcategory_id, updated_at, variant_group, version, warranty_months) on dpg_app.products to dpg_admin_api_test;
grant delete on dpg_app.products to dpg_admin_api_test;
grant usage, select on sequence dpg_app.products_id_seq to dpg_admin_api_test;
-- projects
grant select (category, description, id, is_active, is_featured, location, slug, sort_order, tags, thumbnail_url, title) on dpg_app.projects to dpg_admin_api_test;
grant insert (category, description, is_active, is_featured, location, slug, sort_order, tags, thumbnail_url, title) on dpg_app.projects to dpg_admin_api_test;
grant update (category, description, is_active, is_featured, location, sort_order, tags, thumbnail_url, title, updated_at) on dpg_app.projects to dpg_admin_api_test;
grant delete on dpg_app.projects to dpg_admin_api_test;
grant usage, select on sequence dpg_app.projects_id_seq to dpg_admin_api_test;
-- quote_items
grant select (admin_quantity, admin_unit_price, id, list_price_snapshot, note, product_id, product_name_snapshot, product_sku_snapshot, quantity, quote_id, sale_price_snapshot, snapshot_at) on dpg_app.quote_items to dpg_admin_api_test;
grant update (admin_quantity, admin_unit_price) on dpg_app.quote_items to dpg_admin_api_test;
-- quote_requests
grant select (admin_notes, assigned_to, created_at, customer_id, email, id, message, name, phone, quote_number, shipping_fee, status, updated_at, vat_rate) on dpg_app.quote_requests to dpg_admin_api_test;
grant update (admin_notes, assigned_to, customer_id, shipping_fee, status, updated_at, vat_rate) on dpg_app.quote_requests to dpg_admin_api_test;
-- spec_definitions
grant select (data_type, id, is_filterable, is_pdp_visible, is_reserved, key, label, normalize_rule, sort_order, unit) on dpg_app.spec_definitions to dpg_admin_api_test;
grant insert (data_type, is_filterable, is_pdp_visible, is_reserved, key, label, normalize_rule, sort_order, unit) on dpg_app.spec_definitions to dpg_admin_api_test;
grant update (data_type, is_filterable, is_pdp_visible, is_reserved, key, label, normalize_rule, sort_order, unit, updated_at) on dpg_app.spec_definitions to dpg_admin_api_test;
grant usage, select on sequence dpg_app.spec_definitions_id_seq to dpg_admin_api_test;
-- spec_options
grant select (aliases, id, is_active, slug, sort_order, spec_definition_id, value) on dpg_app.spec_options to dpg_admin_api_test;
grant insert (aliases, is_active, slug, sort_order, spec_definition_id, value) on dpg_app.spec_options to dpg_admin_api_test;
grant usage, select on sequence dpg_app.spec_options_id_seq to dpg_admin_api_test;
-- subcategories
grant select (category_id, id, is_active, name, slug, sort_order) on dpg_app.subcategories to dpg_admin_api_test;

-- RLS is enabled on every dpg_app table: allow the role exactly the commands it was granted.
do $$
declare spec record;
begin
  for spec in select * from (values
    ('admin_users','select'),
    ('admin_users','insert'),
    ('admin_users','update'),
    ('banners','select'),
    ('banners','insert'),
    ('banners','update'),
    ('banners','delete'),
    ('blog_categories','select'),
    ('blog_post_tags','select'),
    ('blog_post_tags','insert'),
    ('blog_post_tags','delete'),
    ('blog_posts','select'),
    ('blog_posts','insert'),
    ('blog_posts','update'),
    ('blog_posts','delete'),
    ('blog_tags','select'),
    ('blog_tags','insert'),
    ('blog_tags','update'),
    ('brands','select'),
    ('brands','insert'),
    ('brands','update'),
    ('catalog_taxons','select'),
    ('catalog_taxons','insert'),
    ('catalog_taxons','update'),
    ('categories','select'),
    ('categories','update'),
    ('colors','select'),
    ('customers','select'),
    ('customers','insert'),
    ('customers','update'),
    ('materials','select'),
    ('order_items','select'),
    ('order_items','update'),
    ('orders','select'),
    ('orders','update'),
    ('origins','select'),
    ('partners','select'),
    ('partners','insert'),
    ('partners','update'),
    ('partners','delete'),
    ('product_documents','select'),
    ('product_documents','insert'),
    ('product_documents','update'),
    ('product_documents','delete'),
    ('product_images','select'),
    ('product_images','insert'),
    ('product_images','update'),
    ('product_images','delete'),
    ('product_relationships','select'),
    ('product_relationships','insert'),
    ('product_relationships','update'),
    ('product_relationships','delete'),
    ('product_spec_values','select'),
    ('product_spec_values','insert'),
    ('product_spec_values','update'),
    ('product_spec_values','delete'),
    ('product_sub_types','select'),
    ('product_sub_types','insert'),
    ('product_sub_types','update'),
    ('product_taxon_assignments','select'),
    ('product_taxon_assignments','insert'),
    ('product_taxon_assignments','update'),
    ('product_taxon_assignments','delete'),
    ('product_types','select'),
    ('product_types','insert'),
    ('product_types','update'),
    ('products','select'),
    ('products','insert'),
    ('products','update'),
    ('products','delete'),
    ('projects','select'),
    ('projects','insert'),
    ('projects','update'),
    ('projects','delete'),
    ('quote_items','select'),
    ('quote_items','update'),
    ('quote_requests','select'),
    ('quote_requests','update'),
    ('spec_definitions','select'),
    ('spec_definitions','insert'),
    ('spec_definitions','update'),
    ('spec_options','select'),
    ('spec_options','insert'),
    ('subcategories','select')
  ) as t(tbl,cmd) loop
    execute format('drop policy if exists %I on dpg_app.%I', 'm3_admin_api_'||spec.cmd, spec.tbl);
    if spec.cmd='insert' then
      execute format('create policy %I on dpg_app.%I for insert to dpg_admin_api_test with check (true)', 'm3_admin_api_'||spec.cmd, spec.tbl);
    elsif spec.cmd='update' then
      execute format('create policy %I on dpg_app.%I for update to dpg_admin_api_test using (true) with check (true)', 'm3_admin_api_'||spec.cmd, spec.tbl);
    else
      execute format('create policy %I on dpg_app.%I for %s to dpg_admin_api_test using (true)', 'm3_admin_api_'||spec.cmd, spec.tbl, spec.cmd);
    end if;
  end loop;
end $$;
commit;
