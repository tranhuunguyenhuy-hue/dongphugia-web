-- M3 TEST-only (project uybumsnyqpwcidjxmfsv). Least-privilege role + support tables for the new Admin
-- Edge Function `admin-api` (Owner/TL directive G4, #360 comment 6977090843). Forward migration, idempotent.
-- Operator MUST verify immediately before apply that the runner targets exactly ref uybumsnyqpwcidjxmfsv.
-- The role has no password (it cannot authenticate by itself): the Edge Function connects with the platform
-- credential and runs `SET LOCAL ROLE dpg_admin_api_test` in every request transaction. Column-level grants mirror
-- the Production Public pattern (column privileges + RLS policies per role) so TEST behaves like Production.
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

do $$ begin
  if not exists (select 1 from pg_roles where rolname='dpg_admin_api_test') then
    create role dpg_admin_api_test login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 10;
  end if;
end $$;
alter role dpg_admin_api_test set statement_timeout='10s';
-- The Edge Function connects with the platform-provided credential and switches to this role per transaction
-- (SET LOCAL ROLE), so no extra database password has to be provisioned. Membership is required for that.
do $$ begin
  if exists (select 1 from pg_roles where rolname='postgres') then
    execute 'grant dpg_admin_api_test to postgres';
  end if;
end $$;
alter role dpg_admin_api_test set search_path='dpg_app';

-- Support tables (owned by the migration role; only the API role may touch them besides the owner).
create table if not exists dpg_app.admin_api_login_attempts (
  id bigserial primary key,
  key_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists admin_api_login_attempts_key_created on dpg_app.admin_api_login_attempts (key_hash, created_at);
create table if not exists dpg_app.admin_api_nonces (
  nonce text primary key,
  expires_at timestamptz not null
);
create index if not exists admin_api_nonces_expires on dpg_app.admin_api_nonces (expires_at);
alter table dpg_app.admin_api_login_attempts enable row level security;
alter table dpg_app.admin_api_nonces enable row level security;

grant usage on schema dpg_app to dpg_admin_api_test;
-- Identity and sessions
grant select (id, email, name, password_hash, role, is_active, avatar_url) on dpg_app.admin_users to dpg_admin_api_test;
grant update (last_login_at) on dpg_app.admin_users to dpg_admin_api_test;
grant select, insert, delete on dpg_app.admin_sessions to dpg_admin_api_test;
grant usage, select on sequence dpg_app.admin_sessions_id_seq to dpg_admin_api_test;
-- Persistent rate limit and replay protection
grant select, insert, delete on dpg_app.admin_api_login_attempts to dpg_admin_api_test;
grant usage, select on sequence dpg_app.admin_api_login_attempts_id_seq to dpg_admin_api_test;
grant select, insert, delete on dpg_app.admin_api_nonces to dpg_admin_api_test;
-- Audit
grant insert on dpg_app.audit_logs to dpg_admin_api_test;
grant usage, select on sequence dpg_app.audit_logs_id_seq to dpg_admin_api_test;
-- Products slice: read the editable projection, update only non-price, non-identity columns
grant select (id, sku, name, display_name, slug, category_id, subcategory_id, brand_id, price, price_display, description,
  image_main_url, is_active, is_featured, publication_status, pdp_visibility, listing_visibility, search_visibility,
  seo_title, seo_description, updated_at, version) on dpg_app.products to dpg_admin_api_test;
grant update (name, display_name, description, image_main_url, is_active, is_featured, publication_status,
  pdp_visibility, listing_visibility, seo_title, seo_description, updated_at, version) on dpg_app.products to dpg_admin_api_test;
grant select (id, name, slug, is_active) on dpg_app.categories to dpg_admin_api_test;
grant select (id, category_id, name, slug, is_active) on dpg_app.subcategories to dpg_admin_api_test;
grant select (id, name, slug, is_active) on dpg_app.brands to dpg_admin_api_test;

-- RLS is enabled on every dpg_app table; grant the role exactly the commands it needs.
do $$
declare spec record;
begin
  for spec in select * from (values
    ('admin_users','select'),('admin_users','update'),
    ('admin_sessions','select'),('admin_sessions','insert'),('admin_sessions','delete'),
    ('admin_api_login_attempts','select'),('admin_api_login_attempts','insert'),('admin_api_login_attempts','delete'),
    ('admin_api_nonces','select'),('admin_api_nonces','insert'),('admin_api_nonces','delete'),
    ('audit_logs','insert'),
    ('products','select'),('products','update'),
    ('categories','select'),('subcategories','select'),('brands','select')
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

-- Supabase API roles never get access to these tables.
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on dpg_app.admin_api_login_attempts from %I', r);
      execute format('revoke all on dpg_app.admin_api_nonces from %I', r);
    end if;
  end loop;
end $$;
