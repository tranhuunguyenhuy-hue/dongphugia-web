-- Rollback of: M3 TEST-only (project uybumsnyqpwcidjxmfsv): column-level grants + RLS for the Admin resources served by `admin-api`.
-- GENERATED - removes only what the forward migration granted (tables owned by an earlier migration keep their SELECT).

revoke all on dpg_app.banners from dpg_admin_api_test;
revoke all on sequence dpg_app.banners_id_seq from dpg_admin_api_test;
revoke all on dpg_app.blog_categories from dpg_admin_api_test;
revoke all on dpg_app.blog_post_tags from dpg_admin_api_test;
revoke all on dpg_app.blog_posts from dpg_admin_api_test;
revoke all on sequence dpg_app.blog_posts_id_seq from dpg_admin_api_test;
revoke all on dpg_app.blog_tags from dpg_admin_api_test;
revoke all on sequence dpg_app.blog_tags_id_seq from dpg_admin_api_test;
revoke all on dpg_app.partners from dpg_admin_api_test;
revoke all on sequence dpg_app.partners_id_seq from dpg_admin_api_test;
revoke all on dpg_app.projects from dpg_admin_api_test;
revoke all on sequence dpg_app.projects_id_seq from dpg_admin_api_test;
do $$
declare spec record;
begin
  for spec in select * from (values
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
    ('partners','select'),
    ('partners','insert'),
    ('partners','update'),
    ('partners','delete'),
    ('projects','select'),
    ('projects','insert'),
    ('projects','update'),
    ('projects','delete')
  ) as t(tbl,cmd) loop
    if spec.cmd <> 'select' or spec.tbl not in ('') then
      execute format('drop policy if exists %I on dpg_app.%I', 'm3_admin_api_'||spec.cmd, spec.tbl);
    end if;
  end loop;
end $$;
