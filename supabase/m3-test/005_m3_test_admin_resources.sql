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
-- customers
grant select (created_at, email, full_name, id, last_interacted_at, notes, phone, source) on dpg_app.customers to dpg_admin_api_test;
grant insert (email, full_name, last_interacted_at, notes, phone, source) on dpg_app.customers to dpg_admin_api_test;
grant update (email, full_name, notes, phone, source, updated_at) on dpg_app.customers to dpg_admin_api_test;
grant usage, select on sequence dpg_app.customers_id_seq to dpg_admin_api_test;
-- partners
grant select (description, gradient_class, id, is_active, link_url, logo_url, name, slug, sort_order, tier) on dpg_app.partners to dpg_admin_api_test;
grant insert (description, gradient_class, is_active, link_url, logo_url, name, slug, sort_order, tier) on dpg_app.partners to dpg_admin_api_test;
grant update (description, gradient_class, is_active, link_url, logo_url, name, sort_order, tier, updated_at) on dpg_app.partners to dpg_admin_api_test;
grant delete on dpg_app.partners to dpg_admin_api_test;
grant usage, select on sequence dpg_app.partners_id_seq to dpg_admin_api_test;
-- product_sub_types
grant select (id, is_active, name, product_type_id, slug, sort_order) on dpg_app.product_sub_types to dpg_admin_api_test;
grant insert (is_active, name, product_type_id, slug, sort_order) on dpg_app.product_sub_types to dpg_admin_api_test;
grant update (is_active, name, product_type_id, slug, sort_order) on dpg_app.product_sub_types to dpg_admin_api_test;
grant usage, select on sequence dpg_app.product_sub_types_id_seq to dpg_admin_api_test;
-- product_types
grant select (description, filter_policy, id, is_active, name, slug, sort_order, subcategory_id) on dpg_app.product_types to dpg_admin_api_test;
grant insert (description, filter_policy, is_active, name, slug, sort_order, subcategory_id) on dpg_app.product_types to dpg_admin_api_test;
grant update (description, filter_policy, is_active, name, slug, sort_order, subcategory_id, updated_at) on dpg_app.product_types to dpg_admin_api_test;
grant usage, select on sequence dpg_app.product_types_id_seq to dpg_admin_api_test;
-- projects
grant select (category, description, id, is_active, is_featured, location, slug, sort_order, tags, thumbnail_url, title) on dpg_app.projects to dpg_admin_api_test;
grant insert (category, description, is_active, is_featured, location, slug, sort_order, tags, thumbnail_url, title) on dpg_app.projects to dpg_admin_api_test;
grant update (category, description, is_active, is_featured, location, sort_order, tags, thumbnail_url, title, updated_at) on dpg_app.projects to dpg_admin_api_test;
grant delete on dpg_app.projects to dpg_admin_api_test;
grant usage, select on sequence dpg_app.projects_id_seq to dpg_admin_api_test;
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
    ('customers','select'),
    ('customers','insert'),
    ('customers','update'),
    ('partners','select'),
    ('partners','insert'),
    ('partners','update'),
    ('partners','delete'),
    ('product_sub_types','select'),
    ('product_sub_types','insert'),
    ('product_sub_types','update'),
    ('product_types','select'),
    ('product_types','insert'),
    ('product_types','update'),
    ('projects','select'),
    ('projects','insert'),
    ('projects','update'),
    ('projects','delete'),
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
