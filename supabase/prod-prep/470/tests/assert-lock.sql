-- Commerce lock (004): every direct entrypoint of a self-registered `authenticated` user is closed; reads still work; anon/service_role have nothing.
create function pg_temp.assert(cond bool, msg text) returns void language plpgsql as $$ begin if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if; end $$;
create function pg_temp.denied(stmt text, msg text) returns void language plpgsql as $$
begin begin execute stmt; exception when insufficient_privilege then return; end; raise exception 'ASSERT FAILED (allowed): %', msg; end $$;
select set_config('request.jwt.claims','{"sub":"22222222-2222-2222-2222-222222222222"}',false);
set role authenticated;
-- the 6 mutating RPCs (authenticated + publishable key is the PostgREST path)
select pg_temp.denied($$select public.runtime_order_create('{"customer_name":"x","customer_phone":"0900000001","items":[{"productId":1,"quantity":1}]}'::jsonb,'key-lock-000001',null)$$,'order_create RPC');
select pg_temp.denied($$select public.runtime_order_update(1,'{}'::jsonb,'key-lock-000002',null)$$,'order_update RPC');
select pg_temp.denied($$select public.runtime_order_delete(1,'key-lock-000003',null)$$,'order_delete RPC');
select pg_temp.denied($$select public.runtime_quote_create('{"name":"x","phone":"0900000001","products":[{"product_id":1}]}'::jsonb,'key-lock-000004',null)$$,'quote_create RPC');
select pg_temp.denied($$select public.runtime_quote_update(1,'{}'::jsonb,'key-lock-000005',null)$$,'quote_update RPC');
select pg_temp.denied($$select public.runtime_quote_delete(1,'key-lock-000006',null)$$,'quote_delete RPC');
-- the table path that skips the functions (arbitrary totals, owner-bound RLS would allow it)
select pg_temp.denied($$insert into dpg_app.orders(id,order_number,customer_name,customer_phone,subtotal,total,status,payment_status,owner_id) values (900001,'DPG-X','x','0900000001',1,1,'pending','unpaid','22222222-2222-2222-2222-222222222222')$$,'direct INSERT orders');
select pg_temp.denied($$insert into dpg_app.order_items(order_id,product_id,product_name,product_sku,quantity,unit_price,total_price) values (1,1,'x','x',1,1,1)$$,'direct INSERT order_items');
select pg_temp.denied($$insert into dpg_app.quote_requests(id,name,phone,status,owner_id) values (900002,'x','0900000001','pending','22222222-2222-2222-2222-222222222222')$$,'direct INSERT quote_requests');
select pg_temp.denied($$insert into dpg_app.quote_items(quote_id,product_id,quantity) values (1,1,1)$$,'direct INSERT quote_items');
select pg_temp.denied($$update dpg_app.orders set total = 1$$,'direct UPDATE orders');
select pg_temp.denied($$delete from dpg_app.orders$$,'direct DELETE orders');
select pg_temp.denied($$update dpg_app.quote_requests set status='accepted'$$,'direct UPDATE quote_requests');
select pg_temp.denied($$delete from dpg_app.quote_items$$,'direct DELETE quote_items');
select pg_temp.denied($$insert into dpg_app.runtime_idempotency_records(owner_id,operation,key_hash,request_hash,safe_response,resource_type,resource_id,expires_at) values ('22222222-2222-2222-2222-222222222222','order.create',md5('a')||md5('a'),md5('a')||md5('a'),'{}','order','x',now())$$,'direct INSERT idempotency');
select pg_temp.denied($$insert into dpg_app.runtime_audit_events(owner_id,actor_id,operation,resource_type,resource_id) values ('22222222-2222-2222-2222-222222222222','22222222-2222-2222-2222-222222222222','order.create','order','1')$$,'direct INSERT audit');
select pg_temp.denied($$select nextval('dpg_app.orders_id_seq')$$,'sequence burn');
-- read-only RPCs and own-row reads are untouched
select public.runtime_order_get(1); select public.runtime_order_list(10,0); select public.runtime_quote_get(1); select public.runtime_quote_list(10,0);
select count(*) from dpg_app.orders; select count(*) from dpg_app.quote_items;
reset role;
-- anon and service_role: nothing at all
select pg_temp.assert(not exists (select 1 from (values ('anon'),('service_role')) r(r) cross join pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'runtime\_%' and has_function_privilege(r.r, p.oid, 'EXECUTE')),'anon/service_role have no EXECUTE');
select pg_temp.assert(not exists (select 1 from (values ('anon'),('service_role')) r(r) cross join (values ('dpg_app.orders'),('dpg_app.order_items'),('dpg_app.quote_requests'),('dpg_app.quote_items')) t(t) where has_table_privilege(r.r, t.t, 'SELECT,INSERT,UPDATE,DELETE')),'anon/service_role have no table privilege');
-- Production roles other than the owner never hold a write path (dpg_runtime/dpg_readonly are read-only by baseline)
select pg_temp.assert(not has_table_privilege('dpg_runtime','dpg_app.orders','INSERT') and not has_table_privilege('dpg_readonly','dpg_app.orders','INSERT'),'runtime/readonly cannot write orders');
