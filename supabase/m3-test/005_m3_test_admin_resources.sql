-- M3 TEST-only (project uybumsnyqpwcidjxmfsv): column-level grants + RLS for the Admin resources served by `admin-api`.
-- GENERATED from supabase/functions/admin-api/resources.ts by scripts/m3/generate-admin-resource-grants.mts - do not edit by hand.
-- Forward migration, idempotent (grants and policies are re-created). Operator MUST verify the runner targets the intended project.
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
