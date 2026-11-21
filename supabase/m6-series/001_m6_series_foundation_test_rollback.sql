-- Rollback of 001. Run 003 rollback FIRST (restores option_id from the ledger) so no option is still referenced.
do $$ begin
  if not exists (select 1 from dpg_control.target_contract where environment='preview_synthetic' and production_writes_allowed=false and production_data_allowed=false) then
    raise exception 'M6_TARGET_GUARD_FAILED:not_the_synthetic_staging_target';
  end if;
end $$;

drop trigger if exists series_assignment_guard on dpg_app.product_spec_values;
drop function if exists dpg_app.series_assignment_guard();
delete from dpg_app.spec_options o using dpg_app.spec_definitions d
 where d.id=o.spec_definition_id and d.key='Bộ sưu tập' and (o.slug like 'toto-%-series' or o.slug like 'inax-%-line')
   and not exists (select 1 from dpg_app.product_spec_values v where v.option_id=o.id);
-- The ledger table is kept as audit evidence (drop manually only after sign-off).
