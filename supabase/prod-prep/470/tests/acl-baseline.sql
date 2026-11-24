-- Mirrors the Production ACL shape of the 10 public runtime RPCs and the 6 commerce tables (read-only evidence 2026-11-24).
-- The fixture only has the two create functions (installed from the 003 rollback = live baseline text); add the other 8 as owner so the
-- ACL under test is the real one: authenticated holds EXECUTE; PUBLIC/anon/service_role hold nothing.
set role dpg_operator;
create function public.runtime_order_get(p_order_id integer) returns jsonb language sql as $$ select null::jsonb $$;
create function public.runtime_order_list(p_limit integer, p_offset integer) returns jsonb language sql as $$ select null::jsonb $$;
create function public.runtime_order_update(p_order_id integer, p_patch jsonb, p_idempotency_key text, p_request_id uuid) returns jsonb language sql as $$ select null::jsonb $$;
create function public.runtime_order_delete(p_order_id integer, p_idempotency_key text, p_request_id uuid) returns jsonb language sql as $$ select null::jsonb $$;
create function public.runtime_quote_get(p_quote_id integer) returns jsonb language sql as $$ select null::jsonb $$;
create function public.runtime_quote_list(p_limit integer, p_offset integer) returns jsonb language sql as $$ select null::jsonb $$;
create function public.runtime_quote_update(p_quote_id integer, p_patch jsonb, p_idempotency_key text, p_request_id uuid) returns jsonb language sql as $$ select null::jsonb $$;
create function public.runtime_quote_delete(p_quote_id integer, p_idempotency_key text, p_request_id uuid) returns jsonb language sql as $$ select null::jsonb $$;
revoke all on function public.runtime_order_create(jsonb,text,uuid), public.runtime_order_get(integer), public.runtime_order_list(integer,integer), public.runtime_order_update(integer,jsonb,text,uuid), public.runtime_order_delete(integer,text,uuid),
  public.runtime_quote_create(jsonb,text,uuid), public.runtime_quote_get(integer), public.runtime_quote_list(integer,integer), public.runtime_quote_update(integer,jsonb,text,uuid), public.runtime_quote_delete(integer,text,uuid) from public, anon, service_role;
grant execute on function public.runtime_order_create(jsonb,text,uuid), public.runtime_order_get(integer), public.runtime_order_list(integer,integer), public.runtime_order_update(integer,jsonb,text,uuid), public.runtime_order_delete(integer,text,uuid),
  public.runtime_quote_create(jsonb,text,uuid), public.runtime_quote_get(integer), public.runtime_quote_list(integer,integer), public.runtime_quote_update(integer,jsonb,text,uuid), public.runtime_quote_delete(integer,text,uuid) to authenticated;
reset role;
