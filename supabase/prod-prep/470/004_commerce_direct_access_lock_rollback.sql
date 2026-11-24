-- #470 DRAFT — rollback of 004: restores EXACTLY the baseline ACL captured read-only from Production on 2026-11-24
-- (leo541_runtime_api: authenticated holds EXECUTE on the 6 mutating RPCs, INSERT/UPDATE/DELETE on the 5 order/quote tables,
--  INSERT on runtime_audit_events, USAGE+SELECT on the 5 sequences). Re-opening direct commerce access is a business decision;
-- only run it on a separate Owner GO naming this file and the exact SHA.
begin;
set local lock_timeout = '5s';
select set_config('dpg.price_release_go', :'approved_sha', true);
do $$ begin
  if coalesce(current_setting('dpg.price_release_go', true), '') = '' then raise exception 'PRICE_RELEASE_NO_OWNER_GO'; end if;
  if not exists (select 1 from dpg_control.target_contract where project_name = 'dongphugia-runtime' and region = 'ap-southeast-1' and environment = 'preview' and hard_database_ceiling_bytes = 367001600) then
    raise exception 'PRICE_RELEASE_TARGET_NOT_PRODUCTION_CONTRACT';
  end if;
end $$;

grant execute on function public.runtime_order_create(jsonb,text,uuid), public.runtime_order_update(integer,jsonb,text,uuid), public.runtime_order_delete(integer,text,uuid),
  public.runtime_quote_create(jsonb,text,uuid), public.runtime_quote_update(integer,jsonb,text,uuid), public.runtime_quote_delete(integer,text,uuid) to authenticated;
grant insert, update, delete on table dpg_app.orders, dpg_app.order_items, dpg_app.quote_requests, dpg_app.quote_items, dpg_app.runtime_idempotency_records to authenticated;
grant insert on table dpg_app.runtime_audit_events to authenticated;
grant usage, select on sequence dpg_app.orders_id_seq, dpg_app.order_items_id_seq, dpg_app.quote_requests_id_seq, dpg_app.quote_items_id_seq, dpg_app.runtime_audit_events_id_seq to authenticated;
commit;
