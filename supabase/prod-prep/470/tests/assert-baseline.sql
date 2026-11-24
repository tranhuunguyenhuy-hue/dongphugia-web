do $$ begin
  if md5(pg_get_functiondef('public.runtime_order_create(jsonb,text,uuid)'::regprocedure)) <> 'a3c83a9ba45a709fdc0b23efd6aa07d8' then raise exception 'ORDER BASELINE MD5 MISMATCH %', md5(pg_get_functiondef('public.runtime_order_create(jsonb,text,uuid)'::regprocedure)); end if;
  if md5(pg_get_functiondef('public.runtime_quote_create(jsonb,text,uuid)'::regprocedure)) <> '2de47a88ea642102d471cb957e4ff930' then raise exception 'QUOTE BASELINE MD5 MISMATCH %', md5(pg_get_functiondef('public.runtime_quote_create(jsonb,text,uuid)'::regprocedure)); end if;
end $$;
