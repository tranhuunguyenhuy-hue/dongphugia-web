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
-- banners
grant select (id, image_url, is_active, link_url, sort_order, title) on dpg_app.banners to dpg_admin_api_test;
grant insert (image_url, is_active, link_url, sort_order, title) on dpg_app.banners to dpg_admin_api_test;
grant update (image_url, is_active, link_url, sort_order, title, updated_at) on dpg_app.banners to dpg_admin_api_test;
grant delete on dpg_app.banners to dpg_admin_api_test;
grant usage, select on sequence dpg_app.banners_id_seq to dpg_admin_api_test;
-- blog_categories
grant select (id, is_active, name, slug) on dpg_app.blog_categories to dpg_admin_api_test;
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
-- partners
grant select (description, gradient_class, id, is_active, link_url, logo_url, name, slug, sort_order, tier) on dpg_app.partners to dpg_admin_api_test;
grant insert (description, gradient_class, is_active, link_url, logo_url, name, slug, sort_order, tier) on dpg_app.partners to dpg_admin_api_test;
grant update (description, gradient_class, is_active, link_url, logo_url, name, sort_order, tier, updated_at) on dpg_app.partners to dpg_admin_api_test;
grant delete on dpg_app.partners to dpg_admin_api_test;
grant usage, select on sequence dpg_app.partners_id_seq to dpg_admin_api_test;
-- projects
grant select (category, description, id, is_active, is_featured, location, slug, sort_order, tags, thumbnail_url, title) on dpg_app.projects to dpg_admin_api_test;
grant insert (category, description, is_active, is_featured, location, slug, sort_order, tags, thumbnail_url, title) on dpg_app.projects to dpg_admin_api_test;
grant update (category, description, is_active, is_featured, location, sort_order, tags, thumbnail_url, title, updated_at) on dpg_app.projects to dpg_admin_api_test;
grant delete on dpg_app.projects to dpg_admin_api_test;
grant usage, select on sequence dpg_app.projects_id_seq to dpg_admin_api_test;

-- RLS is enabled on every dpg_app table: allow the role exactly the commands it was granted.
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
