-- Rollback of 002: removes ONLY rows created by this fixture (source_system='fixture-432'); brands/subcategories removed if left empty.
do $$ begin
  if not exists (select 1 from dpg_control.target_contract where environment='preview_synthetic' and production_writes_allowed=false and production_data_allowed=false) then
    raise exception 'M6_TARGET_GUARD_FAILED:not_the_synthetic_staging_target';
  end if;
end $$;

delete from dpg_app.product_spec_values where product_id in (select id from dpg_app.products where source_system='fixture-432');
delete from dpg_app.products where source_system='fixture-432';
delete from dpg_app.subcategories s where s.slug in ('sen-tam','voi-chau') and not exists (select 1 from dpg_app.products p where p.subcategory_id=s.id);
delete from dpg_app.brands b where b.slug in ('toto','inax') and not exists (select 1 from dpg_app.products p where p.brand_id=b.id);
