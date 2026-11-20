-- M5 CDN Phase 0 (read-only). One line per stored legacy-CDN reference:
-- table <TAB> pk <TAB> column <TAB> product_id <TAB> path-after-prefix <TAB> quote-anchored(1/0)
-- Prefix is the exact origin 'https://cdn.dongphugia.com.vn/'. Public media paths only; no other row data.
with h as (select 'https://cdn\.dongphugia\.com\.vn/'::text re)
select concat_ws(E'\t', 'product_images', id, 'image_url', product_id, regexp_replace(image_url, '^https://cdn\.dongphugia\.com\.vn/', ''), 1)
  from dpg_app.product_images where starts_with(image_url, 'https://cdn.dongphugia.com.vn/')
union all
select concat_ws(E'\t', 'products', id, 'image_main_url', id, regexp_replace(image_main_url, '^https://cdn\.dongphugia\.com\.vn/', ''), 1)
  from dpg_app.products where starts_with(image_main_url, 'https://cdn.dongphugia.com.vn/')
union all
select concat_ws(E'\t', 'product_documents', id, 'url', product_id, regexp_replace(url, '^https://cdn\.dongphugia\.com\.vn/', ''), 1)
  from dpg_app.product_documents where starts_with(url, 'https://cdn.dongphugia.com.vn/')
union all
select concat_ws(E'\t', 'products', p.id, 'description', p.id, m[2], (m[1] in ('"', ''''))::int)
  from dpg_app.products p, h, regexp_matches(p.description, '(^|.)' || h.re || '([^"''<>[:space:]]*)', 'g') m
union all
select concat_ws(E'\t', 'products', p.id, 'specs', p.id, m[2], (m[1] = '"')::int)
  from dpg_app.products p, h, regexp_matches(p.specs::text, '(^|.)' || h.re || '([^"''<>[:space:]\\]*)', 'g') m
union all
select concat_ws(E'\t', 'product_descriptions', d.id, 'clean_html', d.product_id, m[2], (m[1] in ('"', ''''))::int)
  from dpg_app.product_descriptions d, h, regexp_matches(d.clean_html, '(^|.)' || h.re || '([^"''<>[:space:]]*)', 'g') m
union all
select concat_ws(E'\t', 'blog_posts', id, c.col, '', regexp_replace(c.v, '^https://cdn\.dongphugia\.com\.vn/', ''), 1)
  from dpg_app.blog_posts, lateral (values ('thumbnail_url', thumbnail_url), ('cover_image_url', cover_image_url)) c(col, v)
  where starts_with(c.v, 'https://cdn.dongphugia.com.vn/');
