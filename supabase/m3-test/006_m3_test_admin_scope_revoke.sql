-- M3 TEST-only (project uybumsnyqpwcidjxmfsv): Owner scope decision (#309 / 19-11-2026): catalogue master data is Dev-managed.
-- REVOKE-ONLY and idempotent, ALL-OR-NOTHING (one transaction). Removes every write privilege and write RLS policy the Admin API role
-- held on the eight shared master-data tables. SELECT privileges, rows, IDs, FKs and the m3_admin_api_select policies are untouched, so
-- the product editor keeps its read-only lookups. Operator MUST verify the runner targets the intended project.
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

do $$ declare missing text; begin
  select string_agg(w.t, ', ') into missing from (values ('categories'),('subcategories'),('brands'),('catalog_taxons'),('product_types'),('product_sub_types'),('spec_definitions'),('spec_options')) as w(t)
   where not exists (select 1 from information_schema.tables i where i.table_schema = 'dpg_app' and i.table_name = w.t);
  if missing is not null then raise exception 'ADMIN_SCOPE_PREFLIGHT_FAILED:tables:%', missing; end if;
end $$;

revoke insert, update, delete on dpg_app.categories from dpg_admin_api_test;
revoke insert, update, delete on dpg_app.subcategories from dpg_admin_api_test;
revoke insert, update, delete on dpg_app.brands from dpg_admin_api_test;
revoke insert, update, delete on dpg_app.catalog_taxons from dpg_admin_api_test;
revoke insert, update, delete on dpg_app.product_types from dpg_admin_api_test;
revoke insert, update, delete on dpg_app.product_sub_types from dpg_admin_api_test;
revoke insert, update, delete on dpg_app.spec_definitions from dpg_admin_api_test;
revoke insert, update, delete on dpg_app.spec_options from dpg_admin_api_test;
revoke usage, select on sequence dpg_app.brands_id_seq from dpg_admin_api_test;
revoke usage, select on sequence dpg_app.catalog_taxons_id_seq from dpg_admin_api_test;
revoke usage, select on sequence dpg_app.product_types_id_seq from dpg_admin_api_test;
revoke usage, select on sequence dpg_app.product_sub_types_id_seq from dpg_admin_api_test;
revoke usage, select on sequence dpg_app.spec_definitions_id_seq from dpg_admin_api_test;
revoke usage, select on sequence dpg_app.spec_options_id_seq from dpg_admin_api_test;

-- The standalone write policies are no longer reachable; remove them as well (select policies stay).
do $$
declare t text; c text;
begin
  foreach t in array array['categories', 'subcategories', 'brands', 'catalog_taxons', 'product_types', 'product_sub_types', 'spec_definitions', 'spec_options'] loop
    foreach c in array array['insert','update','delete'] loop
      execute format('drop policy if exists %I on dpg_app.%I', 'm3_admin_api_'||c, t);
    end loop;
  end loop;
end $$;
commit;
