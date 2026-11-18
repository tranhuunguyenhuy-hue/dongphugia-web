-- Rollback of: M3 TEST-only (project uybumsnyqpwcidjxmfsv): column-level grants + RLS for the Admin resources served by `admin-api`.
-- GENERATED - removes only what the forward migration granted (tables owned by an earlier migration keep their SELECT).

revoke insert, update, delete on dpg_app.admin_users from dpg_admin_api_test;
revoke all on sequence dpg_app.admin_users_id_seq from dpg_admin_api_test;
revoke all on dpg_app.banners from dpg_admin_api_test;
revoke all on sequence dpg_app.banners_id_seq from dpg_admin_api_test;
revoke all on dpg_app.blog_categories from dpg_admin_api_test;
revoke all on dpg_app.blog_post_tags from dpg_admin_api_test;
revoke all on dpg_app.blog_posts from dpg_admin_api_test;
revoke all on sequence dpg_app.blog_posts_id_seq from dpg_admin_api_test;
revoke all on dpg_app.blog_tags from dpg_admin_api_test;
revoke all on sequence dpg_app.blog_tags_id_seq from dpg_admin_api_test;
revoke insert, update, delete on dpg_app.brands from dpg_admin_api_test;
revoke all on sequence dpg_app.brands_id_seq from dpg_admin_api_test;
revoke all on dpg_app.catalog_taxons from dpg_admin_api_test;
revoke all on sequence dpg_app.catalog_taxons_id_seq from dpg_admin_api_test;
revoke insert, update, delete on dpg_app.categories from dpg_admin_api_test;
revoke all on dpg_app.colors from dpg_admin_api_test;
revoke all on dpg_app.customers from dpg_admin_api_test;
revoke all on sequence dpg_app.customers_id_seq from dpg_admin_api_test;
revoke all on dpg_app.materials from dpg_admin_api_test;
revoke all on dpg_app.order_items from dpg_admin_api_test;
revoke all on dpg_app.orders from dpg_admin_api_test;
revoke all on dpg_app.origins from dpg_admin_api_test;
revoke all on dpg_app.partners from dpg_admin_api_test;
revoke all on sequence dpg_app.partners_id_seq from dpg_admin_api_test;
revoke all on dpg_app.product_documents from dpg_admin_api_test;
revoke all on sequence dpg_app.product_documents_id_seq from dpg_admin_api_test;
revoke all on dpg_app.product_images from dpg_admin_api_test;
revoke all on sequence dpg_app.product_images_id_seq from dpg_admin_api_test;
revoke all on dpg_app.product_relationships from dpg_admin_api_test;
revoke all on sequence dpg_app.product_relationships_id_seq from dpg_admin_api_test;
revoke all on dpg_app.product_spec_values from dpg_admin_api_test;
revoke all on sequence dpg_app.product_spec_values_id_seq from dpg_admin_api_test;
revoke all on dpg_app.product_sub_types from dpg_admin_api_test;
revoke all on sequence dpg_app.product_sub_types_id_seq from dpg_admin_api_test;
revoke all on dpg_app.product_taxon_assignments from dpg_admin_api_test;
revoke all on sequence dpg_app.product_taxon_assignments_id_seq from dpg_admin_api_test;
revoke all on dpg_app.product_types from dpg_admin_api_test;
revoke all on sequence dpg_app.product_types_id_seq from dpg_admin_api_test;
revoke all on dpg_app.products from dpg_admin_api_test;
revoke all on sequence dpg_app.products_id_seq from dpg_admin_api_test;
revoke all on dpg_app.projects from dpg_admin_api_test;
revoke all on sequence dpg_app.projects_id_seq from dpg_admin_api_test;
revoke all on dpg_app.quote_items from dpg_admin_api_test;
revoke all on dpg_app.quote_requests from dpg_admin_api_test;
revoke all on dpg_app.spec_definitions from dpg_admin_api_test;
revoke all on sequence dpg_app.spec_definitions_id_seq from dpg_admin_api_test;
revoke all on dpg_app.spec_options from dpg_admin_api_test;
revoke all on sequence dpg_app.spec_options_id_seq from dpg_admin_api_test;
revoke insert, update, delete on dpg_app.subcategories from dpg_admin_api_test;
grant update (last_login_at) on dpg_app.admin_users to dpg_admin_api_test;
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
    if (spec.tbl||'.'||spec.cmd) <> all (array['admin_users.select', 'admin_users.update', 'categories.select', 'subcategories.select', 'brands.select']) then
      execute format('drop policy if exists %I on dpg_app.%I', 'm3_admin_api_'||spec.cmd, spec.tbl);
    end if;
  end loop;
end $$;
