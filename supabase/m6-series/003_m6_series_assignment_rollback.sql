-- Ledger-driven rollback of 003 (newest first). Restores legacy text/raw/source; deletes rows the run inserted.
do $$ begin
  if not exists (select 1 from dpg_control.target_contract where environment='preview_synthetic' and production_writes_allowed=false and production_data_allowed=false) then
    raise exception 'M6_TARGET_GUARD_FAILED:not_the_synthetic_staging_target';
  end if;
end $$;

do $r$ declare l record; begin
  for l in select * from dpg_control.series_assignment_ledger where action in ('UPDATED','INSERTED') order by id desc loop
    if l.action='UPDATED' then
      update dpg_app.product_spec_values set option_id=l.before_option_id, raw_key=l.before_raw_key, raw_value=l.before_raw_value, source=coalesce(l.before_source,source), confidence=coalesce(l.before_confidence,confidence)
       where product_id=l.product_id and spec_definition_id=(select id from dpg_app.spec_definitions where key='Bộ sưu tập') and option_id is not null;
    else
      delete from dpg_app.product_spec_values where product_id=l.product_id and spec_definition_id=(select id from dpg_app.spec_definitions where key='Bộ sưu tập') and source='official-series-page';
    end if;
  end loop;
  delete from dpg_control.series_assignment_ledger where action in ('UPDATED','INSERTED');
end $r$;
