-- Rollback of 006 (TEST only): restores the write privileges and policies that 005 granted on the eight master-data tables.
-- Only use together with re-enabling the corresponding Admin screens; the product editor does not need them.

grant update (banner_url, updated_at) on dpg_app.categories to dpg_admin_api_test;
grant insert (description, is_active, is_featured, logo_url, name, origin_country, slug, sort_order, website_url) on dpg_app.brands to dpg_admin_api_test;
grant update (description, is_active, is_featured, logo_url, name, origin_country, slug, sort_order, updated_at, website_url) on dpg_app.brands to dpg_admin_api_test;
grant insert (canonical_path, depth, is_active, is_indexable, is_listing_enabled, kind, name, parent_id, seo_description, seo_title, slug, sort_order, status) on dpg_app.catalog_taxons to dpg_admin_api_test;
grant update (canonical_path, depth, is_active, is_indexable, is_listing_enabled, kind, name, parent_id, seo_description, seo_title, slug, sort_order, status, updated_at) on dpg_app.catalog_taxons to dpg_admin_api_test;
grant insert (description, filter_policy, is_active, name, slug, sort_order, subcategory_id) on dpg_app.product_types to dpg_admin_api_test;
grant update (description, filter_policy, is_active, name, slug, sort_order, subcategory_id, updated_at) on dpg_app.product_types to dpg_admin_api_test;
grant insert (is_active, name, product_type_id, slug, sort_order) on dpg_app.product_sub_types to dpg_admin_api_test;
grant update (is_active, name, product_type_id, slug, sort_order) on dpg_app.product_sub_types to dpg_admin_api_test;
grant insert (data_type, is_filterable, is_pdp_visible, is_reserved, key, label, normalize_rule, sort_order, unit) on dpg_app.spec_definitions to dpg_admin_api_test;
grant update (data_type, is_filterable, is_pdp_visible, is_reserved, key, label, normalize_rule, sort_order, unit, updated_at) on dpg_app.spec_definitions to dpg_admin_api_test;
grant insert (aliases, is_active, slug, sort_order, spec_definition_id, value) on dpg_app.spec_options to dpg_admin_api_test;
grant usage, select on sequence dpg_app.brands_id_seq to dpg_admin_api_test;
grant usage, select on sequence dpg_app.catalog_taxons_id_seq to dpg_admin_api_test;
grant usage, select on sequence dpg_app.product_types_id_seq to dpg_admin_api_test;
grant usage, select on sequence dpg_app.product_sub_types_id_seq to dpg_admin_api_test;
grant usage, select on sequence dpg_app.spec_definitions_id_seq to dpg_admin_api_test;
grant usage, select on sequence dpg_app.spec_options_id_seq to dpg_admin_api_test;

do $$
declare spec record;
begin
  for spec in select * from (values
    ('categories','update'),
    ('brands','insert'),
    ('brands','update'),
    ('catalog_taxons','insert'),
    ('catalog_taxons','update'),
    ('product_types','insert'),
    ('product_types','update'),
    ('product_sub_types','insert'),
    ('product_sub_types','update'),
    ('spec_definitions','insert'),
    ('spec_definitions','update'),
    ('spec_options','insert')
  ) as t(tbl,cmd) loop
    execute format('drop policy if exists %I on dpg_app.%I', 'm3_admin_api_'||spec.cmd, spec.tbl);
    if spec.cmd='insert' then
      execute format('create policy %I on dpg_app.%I for insert to dpg_admin_api_test with check (true)', 'm3_admin_api_'||spec.cmd, spec.tbl);
    elsif spec.cmd='update' then
      execute format('create policy %I on dpg_app.%I for update to dpg_admin_api_test using (true) with check (true)', 'm3_admin_api_'||spec.cmd, spec.tbl);
    else
      execute format('create policy %I on dpg_app.%I for delete to dpg_admin_api_test using (true)', 'm3_admin_api_'||spec.cmd, spec.tbl);
    end if;
  end loop;
end $$;
