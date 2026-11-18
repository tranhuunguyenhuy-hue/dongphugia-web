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
revoke all on dpg_app.customers from dpg_admin_api_test;
revoke all on sequence dpg_app.customers_id_seq from dpg_admin_api_test;
revoke all on dpg_app.partners from dpg_admin_api_test;
revoke all on sequence dpg_app.partners_id_seq from dpg_admin_api_test;
revoke all on dpg_app.product_sub_types from dpg_admin_api_test;
revoke all on sequence dpg_app.product_sub_types_id_seq from dpg_admin_api_test;
revoke all on dpg_app.product_types from dpg_admin_api_test;
revoke all on sequence dpg_app.product_types_id_seq from dpg_admin_api_test;
revoke all on dpg_app.projects from dpg_admin_api_test;
revoke all on sequence dpg_app.projects_id_seq from dpg_admin_api_test;
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
    if (spec.tbl||'.'||spec.cmd) <> all (array['admin_users.select', 'admin_users.update', 'categories.select', 'subcategories.select', 'brands.select']) then
      execute format('drop policy if exists %I on dpg_app.%I', 'm3_admin_api_'||spec.cmd, spec.tbl);
    end if;
  end loop;
end $$;
