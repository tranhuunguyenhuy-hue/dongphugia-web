-- #470 DRAFT — NOT APPLIED. COMMERCE LOCK: while commerce is OFF in Production nobody may create/alter/delete an order or quote
-- through ANY direct entrypoint. 003 only decides how an order/quote is PRICED; it does not stop a self-registered Supabase user
-- (role `authenticated`, publishable key) from calling the RPCs or writing the tables through PostgREST. This file does.
--
-- Entrypoints closed (verified read-only against Production 2026-11-24; every one is granted to `authenticated` only):
--   * 6 mutating RPCs: runtime_order_create/update/delete, runtime_quote_create/update/delete   -> EXECUTE revoked
--   * table writes: INSERT/UPDATE/DELETE on dpg_app.orders, order_items, quote_requests, quote_items, runtime_idempotency_records
--     (the functions are SECURITY INVOKER; with owner-bound RLS a user could otherwise INSERT an order row with an arbitrary total via PostgREST)
--   * INSERT on dpg_app.runtime_audit_events, USAGE/SELECT on the 5 order/quote sequences
-- Left untouched on purpose: SELECT on those tables and runtime_order_get/list, runtime_quote_get/list (read-only, owner-bound RLS, zero rows today);
--   anon/PUBLIC/service_role already have nothing; dpg_runtime/dpg_readonly keep their read access; no Auth, Edge Function, Worker or flag change.
-- Legitimate consumers: none. Production has no order/quote Edge Function (only admin-api), the Public Worker has no order intake binding and /api/orders,
--   /gio-hang are closed; 0 orders, 0 quotes, 0 auth.users. Re-opening commerce later = a separate Owner GO that applies 004_rollback (exact baseline ACL).
-- Idempotent. Needs nothing from 001-003 (it can be applied alone). Rollback: 004_commerce_direct_access_lock_rollback.sql.
begin;
set local lock_timeout = '5s';
select set_config('dpg.price_release_go', :'approved_sha', true);
do $$
begin
  if coalesce(current_setting('dpg.price_release_go', true), '') = '' then raise exception 'PRICE_RELEASE_NO_OWNER_GO'; end if;
  if not exists (select 1 from dpg_control.target_contract where project_name = 'dongphugia-runtime' and region = 'ap-southeast-1' and environment = 'preview' and hard_database_ceiling_bytes = 367001600) then
    raise exception 'PRICE_RELEASE_TARGET_NOT_PRODUCTION_CONTRACT';
  end if;
  if to_regprocedure('public.runtime_order_create(jsonb,text,uuid)') is null or to_regprocedure('public.runtime_quote_create(jsonb,text,uuid)') is null then
    raise exception 'PRICE_RELEASE_RUNTIME_FUNCTIONS_MISSING';
  end if;
end
$$;

revoke execute on function public.runtime_order_create(jsonb,text,uuid), public.runtime_order_update(integer,jsonb,text,uuid), public.runtime_order_delete(integer,text,uuid),
  public.runtime_quote_create(jsonb,text,uuid), public.runtime_quote_update(integer,jsonb,text,uuid), public.runtime_quote_delete(integer,text,uuid)
  from public, anon, authenticated, service_role;
revoke insert, update, delete on table dpg_app.orders, dpg_app.order_items, dpg_app.quote_requests, dpg_app.quote_items, dpg_app.runtime_idempotency_records
  from public, anon, authenticated, service_role;
revoke insert on table dpg_app.runtime_audit_events from public, anon, authenticated, service_role;
revoke usage, select on sequence dpg_app.orders_id_seq, dpg_app.order_items_id_seq, dpg_app.quote_requests_id_seq, dpg_app.quote_items_id_seq, dpg_app.runtime_audit_events_id_seq
  from public, anon, authenticated, service_role;

-- post-condition: no non-owner role keeps a write path (fail the whole transaction otherwise)
do $$
declare v_bad text;
begin
  select string_agg(r || ' ' || o, ', ') into v_bad
    from (values ('authenticated'), ('anon'), ('service_role')) roles(r)
    cross join (values ('public.runtime_order_create(jsonb,text,uuid)'), ('public.runtime_order_update(integer,jsonb,text,uuid)'), ('public.runtime_order_delete(integer,text,uuid)'),
                       ('public.runtime_quote_create(jsonb,text,uuid)'), ('public.runtime_quote_update(integer,jsonb,text,uuid)'), ('public.runtime_quote_delete(integer,text,uuid)')) fns(o)
   where exists (select 1 from pg_roles where rolname = r) and has_function_privilege(r, o, 'EXECUTE');
  if v_bad is not null then raise exception 'COMMERCE_LOCK_INCOMPLETE_FUNCTIONS %', v_bad; end if;
  select string_agg(r || ' ' || t || ' ' || p, ', ') into v_bad
    from (values ('authenticated'), ('anon'), ('service_role')) roles(r)
    cross join (values ('dpg_app.orders'), ('dpg_app.order_items'), ('dpg_app.quote_requests'), ('dpg_app.quote_items'), ('dpg_app.runtime_idempotency_records'), ('dpg_app.runtime_audit_events')) tbls(t)
    cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) privs(p)
   where exists (select 1 from pg_roles where rolname = r) and has_table_privilege(r, t, p);
  if v_bad is not null then raise exception 'COMMERCE_LOCK_INCOMPLETE_TABLES %', v_bad; end if;
end
$$;
commit;
