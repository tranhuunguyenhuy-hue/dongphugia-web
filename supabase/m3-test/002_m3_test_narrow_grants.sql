-- M3 TEST-only supplementary migration (does not edit 001). Narrows grants/policies to what the
-- legacy Admin and Public actually use. Fail-closed target guard: the TEST target_contract
-- signature must match (Production's differs: environment='preview', production_data_allowed=true),
-- the dedicated roles must exist, and no Production-derived data class may be present.
do $$ begin
  if not exists (select 1 from dpg_control.target_contract
      where environment='preview_synthetic' and data_class='synthetic-with-approved-public-fixtures'
        and production_data_allowed is false and production_credentials_allowed is false
        and production_writes_allowed is false) then
    raise exception 'M3_TEST_TARGET_GUARD_FAILED';
  end if;
  if (select count(*) from pg_roles where rolname in ('dpg_admin_m3_test','dpg_public_m3_test')) <> 2 then
    raise exception 'M3_TEST_ROLES_MISSING';
  end if;
  if exists (select 1 from dpg_app.products where name !~ '^(PREVIEW ONLY|M3 TEST)') then
    raise exception 'M3_TEST_NON_SYNTHETIC_DATA_PRESENT';
  end if;
end $$;

do $$
declare t text;
declare admin_denied text[] := array[
  -- publishing credentials/identities and machine publishing state
  'publishing_audit_events','publishing_blog_post_media','publishing_credentials','publishing_global_controls',
  'publishing_idempotency_records','publishing_identity_capabilities','publishing_identity_ip_allowlist',
  'publishing_machine_identities','publishing_managed_media','publishing_rate_limit_windows','publishing_scheduler_state',
  -- crawl/import and mapping tables (no legacy Admin module uses them)
  'crawl_import_decisions','crawl_product_snapshots','crawl_runs','product_source_mappings','external_taxonomy_mappings','redirects',
  -- Phase 2 / order-intake / runtime / probe tables (order-intake v7 consumers)
  'guest_order_idempotency_records','guest_order_rate_limit_windows','leo539_rls_probe',
  'phase2_admin_order_status_idempotency','phase2_order_confirmations','runtime_audit_events','runtime_idempotency_records'];
declare public_tables text[] := array[
  'products','categories','subcategories','brands','product_images','product_descriptions','product_spec_values',
  'spec_definitions','spec_options','product_documents','product_feature_values','product_features','blog_posts','blog_categories',
  'blog_tags','blog_post_tags','product_variant_groups','product_relationships','filter_definitions','banners','product_types',
  'product_sub_types','origins','materials','colors','catalog_taxons','product_taxon_assignments','partners','projects',
  'product_package_items','product_secondary_subcategories'];
begin
  foreach t in array admin_denied loop
    execute format('drop policy if exists m3_test_admin_all on dpg_app.%I', t);
    execute format('revoke all on dpg_app.%I from dpg_admin_m3_test', t);
  end loop;
  -- Public: SELECT only on the exact public set; remove anything else previously granted
  for t in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='dpg_app' and c.relkind='r' loop
    if t = any(public_tables) then
      execute format('grant select on dpg_app.%I to dpg_public_m3_test', t);
      execute format('drop policy if exists m3_test_public_select on dpg_app.%I', t);
      execute format('create policy m3_test_public_select on dpg_app.%I for select to dpg_public_m3_test using (true)', t);
    else
      execute format('drop policy if exists m3_test_public_select on dpg_app.%I', t);
      execute format('revoke all on dpg_app.%I from dpg_public_m3_test', t);
    end if;
  end loop;
  -- sequences: only for tables the Admin role can still write
  execute 'revoke all on all sequences in schema dpg_app from dpg_admin_m3_test, dpg_public_m3_test';
  for t in select s.relname from pg_class s join pg_depend d on d.objid=s.oid and d.deptype in ('a','i')
      join pg_class tb on tb.oid=d.refobjid join pg_namespace n on n.oid=s.relnamespace
      where s.relkind='S' and n.nspname='dpg_app' and tb.relname <> all(admin_denied) loop
    execute format('grant usage, select on sequence dpg_app.%I to dpg_admin_m3_test', t);
  end loop;
end $$;
revoke create on schema public from dpg_admin_m3_test, dpg_public_m3_test;
revoke all on all tables in schema public from dpg_admin_m3_test, dpg_public_m3_test;
