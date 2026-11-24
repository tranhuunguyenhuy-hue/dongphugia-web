-- ACL of every object the commerce lock touches (deterministic text; compare byte-for-byte before/after)
select string_agg(x, E'\n' order by x) from (
  select 'fn ' || p.oid::regprocedure::text || ' ' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(p.proacl) a), '-') x from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'runtime\_%'
  union all select 'rel ' || c.relname || ' ' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(c.relacl) a), '-') from pg_class c where c.relnamespace = 'dpg_app'::regnamespace
     and c.relname in ('orders','order_items','quote_requests','quote_items','runtime_idempotency_records','runtime_audit_events','orders_id_seq','quote_requests_id_seq')
) s;
