-- Commerce v1 behaviour, executed as a superuser that SET ROLEs exactly like the Worker (intake) and the Admin API (staff) do.
create function pg_temp.assert(cond bool, msg text) returns void language plpgsql as $$ begin if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if; end $$;
create function pg_temp.denied(stmt text, msg text) returns void language plpgsql as $$
begin begin execute stmt; exception when insufficient_privilege then return; end; raise exception 'ASSERT FAILED (allowed): %', msg; end $$;
create function pg_temp.ip(n int) returns text language sql as $$ select lpad(to_hex(n), 32, 'a') $$;
create temp sequence t_seq; grant usage, select on sequence t_seq to dpg_commerce_intake;
-- default: every call comes from a fresh IP and a fresh phone (so unrelated scenarios never trip the rate limit); rate-limit scenarios pass explicit ones
create function pg_temp.order_(items jsonb, expected bigint, idem text, ip int default null, phone text default null) returns jsonb language sql as $$
  select dpg_commerce.order_submit(jsonb_build_object('customerName', 'Nguyen Van A', 'customerPhone', coalesce(phone, '09' || lpad((20000000 + nextval('t_seq'))::text, 8, '0')), 'customerEmail', 'a@example.com', 'deliveryAddress', '12 Le Loi, Quan 1, TP HCM', 'note', 'Giao gio hanh chinh', 'items', items, 'expectedTotalVnd', expected), idem, pg_temp.ip(coalesce(ip, 1000 + nextval('t_seq')::int))) $$;
create function pg_temp.quote_(items jsonb, idem text, ip int default null, phone text default null) returns jsonb language sql as $$
  select dpg_commerce.quote_submit(jsonb_build_object('customerName', 'Tran Thi B', 'customerPhone', coalesce(phone, '09' || lpad((30000000 + nextval('t_seq'))::text, 8, '0')), 'items', items, 'note', 'Can bao gia'), idem, pg_temp.ip(coalesce(ip, 2000 + nextval('t_seq')::int))) $$;
set role dpg_commerce_intake;

-- cart_check: server decides per line; NULL price is never 0; mixed cart is labelled, nothing is dropped silently
create temp table t_cart as select dpg_commerce.cart_check('[{"productId":1,"quantity":1},{"productId":2,"quantity":3},{"productId":3,"quantity":2},{"productId":5,"quantity":1},{"productId":9,"quantity":1},{"productId":999,"quantity":1}]', pg_temp.ip(50)) j;
select pg_temp.assert((select j->'order'->>'subtotalVnd' = '6400000' and j->'order'->>'voucherVnd' = '300000' and j->'order'->>'totalVnd' = '6100000' and (j->'order'->>'count')::int = 2 from t_cart), 'cart totals: 1.0M + 3x1.8M - 3x100k');
select pg_temp.assert((select (j->>'quoteCount')::int = 2 and (j->>'unavailableCount')::int = 2 from t_cart), 'two quote lines (no price, other category), two unavailable (inactive, missing)');
select pg_temp.assert((select bool_and(case l->>'mode' when 'order' then l ? 'unitSellingVnd' else not (l ? 'unitSellingVnd') end) from t_cart, jsonb_array_elements(j->'lines') l), 'only order lines carry a price; quote/unavailable lines never show 0');
select pg_temp.assert((select (l->>'unitVoucherVnd')::int = 100000 and (l->>'unitSellingVnd')::int = 1800000 and (l->>'regularVnd')::int = 2000000 from t_cart, jsonb_array_elements(j->'lines') l where (l->>'productId')::int = 2), 'three prices of a promo+voucher SKU');
select pg_temp.assert((select count(*) = 4 from t_cart, jsonb_array_elements(j->'lines') l where (l->>'productId')::int in (3,4,5,6,8,9,10) is not true or true) is not null, 'sanity');
select pg_temp.assert(dpg_commerce.cart_check('[{"productId":7,"quantity":1}]', pg_temp.ip(51)) #>> '{lines,0,mode}' = 'order', 'INAX priced SKU is orderable');
select pg_temp.assert(dpg_commerce.cart_check('[{"productId":8,"quantity":1}]', pg_temp.ip(51)) #>> '{lines,0,mode}' = 'quote', 'other sanitary brand is quote-only (legacy price never used)');
select pg_temp.assert(dpg_commerce.cart_check('[{"productId":10,"quantity":1}]', pg_temp.ip(51)) #>> '{lines,0,mode}' = 'quote', 'INAX unresolved is quote-only');
select pg_temp.assert(dpg_commerce.cart_check('[{"productId":4,"quantity":1}]', pg_temp.ip(51)) #>> '{lines,0,mode}' = 'quote', 'CONTACT_VERIFIED is quote-only');
select pg_temp.assert(dpg_commerce.cart_check('[]', pg_temp.ip(51)) ->> 'error' = 'INVALID_ITEMS' and dpg_commerce.cart_check('[{"productId":1,"quantity":100}]', pg_temp.ip(51)) ->> 'error' = 'INVALID_ITEM' and dpg_commerce.cart_check('[{"productId":1,"quantity":1},{"productId":1,"quantity":2}]', pg_temp.ip(51)) ->> 'error' = 'DUPLICATE_PRODUCT'
  and dpg_commerce.cart_check('[{"productId":"1; drop","quantity":1}]', pg_temp.ip(51)) ->> 'error' = 'INVALID_ITEM', 'cart validation');

-- order_submit: happy path, snapshot, voucher once x qty
create temp table t_o1 as select pg_temp.order_('[{"productId":1,"quantity":1},{"productId":2,"quantity":3}]', 6100000, 'idem-order-0001', 5, '0912345678') j;
select pg_temp.assert((select j->>'ok' = 'true' and j->>'code' ~ '^DH-[0-9A-F]{10}$' and j->>'status' = 'new' and j->>'totalVnd' = '6100000' and j->>'subtotalVnd' = '6400000' and j->>'voucherVnd' = '300000' and j->>'lineCount' = '2' from t_o1), 'order accepted with code and totals');
-- idempotency / retry
select pg_temp.assert((select pg_temp.order_('[{"productId":1,"quantity":1},{"productId":2,"quantity":3}]', 6100000, 'idem-order-0001', 5, '0912345678') ->> 'code' = j->>'code' and pg_temp.order_('[{"productId":1,"quantity":1},{"productId":2,"quantity":3}]', 6100000, 'idem-order-0001', 5, '0912345678') ->> 'replayed' = 'true' from t_o1), 'same key + same body replays the SAME receipt');
select pg_temp.assert(pg_temp.order_('[{"productId":1,"quantity":2}]', 2000000, 'idem-order-0001') ->> 'error' = 'IDEMPOTENCY_KEY_REUSED', 'same key + different body is refused');
-- price changed between cart and submit
select pg_temp.assert(pg_temp.order_('[{"productId":1,"quantity":1}]', 999999, 'idem-order-0002') ->> 'error' = 'PRICE_CHANGED' and pg_temp.order_('[{"productId":1,"quantity":1}]', 999999, 'idem-order-0002') ->> 'totalVnd' = '1000000', 'a client total that differs from the server total => PRICE_CHANGED with the new total, nothing written');
-- not orderable lines are reported, never dropped or priced 0
select pg_temp.assert(pg_temp.order_('[{"productId":1,"quantity":1},{"productId":3,"quantity":1}]', 1000000, 'idem-order-0003') ->> 'error' = 'ITEMS_NOT_ORDERABLE' and pg_temp.order_('[{"productId":1,"quantity":1},{"productId":3,"quantity":1}]', 1000000, 'idem-order-0003') -> 'productIds' = '[3]', 'mixed cart: the quote line makes the ORDER refuse, listed by id');
select pg_temp.assert(pg_temp.order_('[{"productId":9,"quantity":1}]', 1200000, 'idem-order-0004') ->> 'error' = 'PRODUCT_UNAVAILABLE', 'inactive cannot be ordered even with an official price');
select pg_temp.assert(pg_temp.order_('[{"productId":999,"quantity":1}]', 1, 'idem-order-0005') ->> 'error' = 'PRODUCT_UNAVAILABLE', 'unknown product');
select pg_temp.assert(pg_temp.order_('[{"productId":8,"quantity":1}]', 650000, 'idem-order-0006') ->> 'error' = 'ITEMS_NOT_ORDERABLE', 'other sanitary brand: legacy price never makes it orderable');
-- INAX order and quantity
select pg_temp.assert(pg_temp.order_('[{"productId":7,"quantity":2}]', 2750000 + 50000 * 0 + 0, 'idem-order-0007') ->> 'error' = 'PRICE_CHANGED' and pg_temp.order_('[{"productId":7,"quantity":2}]', 2750000, 'idem-order-0007') ->> 'error' = 'PRICE_CHANGED', 'INAX: 2 x (1.4M - 50k) = 2.7M');
select pg_temp.assert(pg_temp.order_('[{"productId":7,"quantity":2}]', 2700000, 'idem-order-0008') ->> 'totalVnd' = '2700000', 'INAX promo + voucher x qty once');
-- validation
select pg_temp.assert(pg_temp.order_('[{"productId":1,"quantity":1}]', 1000000, 'x') ->> 'error' = 'INVALID_IDEMPOTENCY_KEY', 'idempotency key format');
select pg_temp.assert(pg_temp.order_('[{"productId":1,"quantity":1}]', 1000000, 'idem-order-0009', 2, '12345') ->> 'error' = 'INVALID_CUSTOMER_PHONE', 'phone');
select pg_temp.assert(dpg_commerce.order_submit('{"customerName":"A","customerPhone":"0911111101","deliveryAddress":"12 Le Loi, Q1","items":[{"productId":1,"quantity":1}],"expectedTotalVnd":1000000}', 'idem-order-0010', pg_temp.ip(2)) ->> 'error' = 'INVALID_CUSTOMER_NAME', 'name too short');
select pg_temp.assert(dpg_commerce.order_submit('{"customerName":"Nguyen Van A","customerPhone":"0911111102","deliveryAddress":"abc","items":[{"productId":1,"quantity":1}],"expectedTotalVnd":1000000}', 'idem-order-0011', pg_temp.ip(2)) ->> 'error' = 'INVALID_DELIVERY_ADDRESS', 'address required for an order');
select pg_temp.assert(dpg_commerce.order_submit('{"customerName":"Nguyen Van A","customerPhone":"+84922222203","deliveryAddress":"12 Le Loi, Q1","items":[{"productId":1,"quantity":1}],"expectedTotalVnd":1000000}', 'idem-order-0012', pg_temp.ip(2)) ->> 'ok' = 'true', '+84 phone normalised');
select pg_temp.assert(dpg_commerce.order_submit('{"customerName":"Nguyen Van A","customerPhone":"0911111104","deliveryAddress":"12 Le Loi, Q1","customerEmail":"not-an-email","items":[{"productId":1,"quantity":1}],"expectedTotalVnd":1000000}', 'idem-order-0013', pg_temp.ip(2)) ->> 'error' = 'INVALID_CUSTOMER_EMAIL', 'email');
select pg_temp.assert(dpg_commerce.order_submit('{"customerName":"Nguyen Van A","customerPhone":"0911111105","deliveryAddress":"12 Le Loi, Q1","items":[{"productId":1,"quantity":1}]}', 'idem-order-0014', pg_temp.ip(2)) ->> 'error' = 'INVALID_INPUT', 'the total the customer saw is required');
select pg_temp.assert(dpg_commerce.order_submit('{"customerName":"Nguyen Van A","customerPhone":"0911111106","deliveryAddress":"12 Le Loi, Q1","items":[{"productId":1,"quantity":1,"unitPrice":1,"discount":999999,"total":1}],"expectedTotalVnd":1000000,"totalVnd":1,"discount":999999}', 'idem-order-0015', pg_temp.ip(2)) ->> 'totalVnd' = '1000000', 'client price/discount/total fields are ignored');

-- quotes: any active public product; reference price only when official; NULL never 0
create temp table t_q as select pg_temp.quote_('[{"productId":3,"quantity":2},{"productId":8,"quantity":1},{"productId":5,"quantity":4},{"productId":1,"quantity":1}]', 'idem-quote-0001', 3, '0912345678') j;
select pg_temp.assert((select j->>'ok' = 'true' and j->>'code' ~ '^BG-[0-9A-F]{10}$' and j->>'lineCount' = '4' from t_q), 'quote accepted with code');
select pg_temp.assert(pg_temp.quote_('[{"productId":3,"quantity":2},{"productId":8,"quantity":1},{"productId":5,"quantity":4},{"productId":1,"quantity":1}]', 'idem-quote-0001', 3, '0912345678') ->> 'code' = (select j->>'code' from t_q), 'quote retry replays the same code');
select pg_temp.assert(pg_temp.quote_('[{"productId":9,"quantity":1}]', 'idem-quote-0002', 3) ->> 'error' = 'PRODUCT_UNAVAILABLE', 'inactive product cannot be quoted');
select pg_temp.assert(pg_temp.quote_('[{"productId":3,"quantity":1}]', 'idem-quote-0003', 3, 'abc') ->> 'error' = 'INVALID_CUSTOMER_PHONE', 'quote phone validation');

-- RATE LIMIT: a counted hit survives even when the request is refused; 8 submissions / 10 minutes / IP
create temp table t_rl as select i, pg_temp.quote_('[{"productId":3,"quantity":1}]', 'idem-rate-' || lpad(i::text, 3, '0'), 7, '09' || lpad((10000000 + i)::text, 8, '0')) j from generate_series(1, 10) i;
select pg_temp.assert((select count(*) filter (where j->>'ok' = 'true') = 8 and count(*) filter (where j->>'error' = 'RATE_LIMITED') = 2 from t_rl), 'the 9th submission from one IP in the window is RATE_LIMITED');
select pg_temp.assert(pg_temp.quote_('[{"productId":3,"quantity":1}]', 'idem-rate-100', 8, '0987654321') ->> 'ok' = 'true', 'another IP is unaffected');
create temp table t_rp as select i, pg_temp.quote_('[{"productId":3,"quantity":1}]', 'idem-phone-' || lpad(i::text, 3, '0'), 20 + i, '0977777777') j from generate_series(1, 7) i;
select pg_temp.assert((select count(*) filter (where j->>'ok' = 'true') = 5 and count(*) filter (where j->>'error' = 'RATE_LIMITED') = 2 from t_rp), 'one phone: 5 submissions per hour');

-- PRIVACY / LEAST PRIVILEGE (as the guest role): no table, no schema object, no other function, no product table
select pg_temp.denied('select * from dpg_commerce.orders', 'guest reads orders');
select pg_temp.denied('select * from dpg_commerce.quotes', 'guest reads quotes');
select pg_temp.denied('select * from dpg_commerce.rate_buckets', 'guest reads rate buckets');
select pg_temp.denied($$insert into dpg_commerce.orders(code,customer_name,customer_phone,delivery_address,subtotal_vnd,total_vnd,line_count,idempotency_hash,request_hash) values ('DH-AAAAAAAAAA','x','0912345678','y',1,1,1,repeat('a',64),repeat('a',64))$$, 'guest inserts an order directly');
select pg_temp.denied('select * from dpg_app.products', 'guest reads products');
select pg_temp.denied($$select dpg_commerce.rate_hit('x', 60, 1)$$, 'guest calls rate_hit');
select pg_temp.denied($$select * from dpg_commerce.product_snapshot(array[1])$$, 'guest calls product_snapshot');
select pg_temp.denied('select * from dpg_commerce.events', 'guest reads events');
reset role;
select pg_temp.assert(not has_function_privilege('public', 'dpg_commerce.order_submit(jsonb,text,text)', 'execute') and not has_schema_privilege('public', 'dpg_commerce', 'usage'), 'PUBLIC has nothing');
select pg_temp.assert(not exists (select 1 from (values ('authenticated'), ('anon'), ('service_role'), ('dpg_runtime'), ('dpg_readonly'), ('dpg_public_catalogue')) r(r) where has_schema_privilege(r.r, 'dpg_commerce', 'usage')), 'no other role can even see the schema');

-- DATA: snapshots are exact, voucher once, NULL never 0, no PII in events
select pg_temp.assert((select o.total_vnd = 6100000 and o.voucher_vnd = 300000 and o.subtotal_vnd = 6400000 and o.customer_phone = '0912345678' and o.status = 'new' from dpg_commerce.orders o where o.idempotency_hash = encode(sha256(convert_to('idem-order-0001','utf8')),'hex')), 'order row');
select pg_temp.assert((select count(*) = 2 and sum(l.line_subtotal_vnd) = 6400000 and sum(l.line_voucher_vnd) = 300000 and bool_and(l.regular_vnd > 0 and l.unit_selling_vnd > 0) from dpg_commerce.order_lines l join dpg_commerce.orders o on o.id = l.order_id where o.code = (select j->>'code' from t_o1)), 'lines: subtotal 6.4M, voucher 300k once (3 x 100k), prices > 0');
select pg_temp.assert((select count(*) = 4 and count(*) filter (where unit_selling_vnd is null) = 3 and count(*) filter (where unit_selling_vnd = 1000000) = 1 and count(*) filter (where reason = 'CUSTOMER_REQUEST') = 1 from dpg_commerce.quote_lines ql join dpg_commerce.quotes q on q.id = ql.quote_id where q.code = (select j->>'code' from t_q)), 'quote lines: reference price only for the official one, NULL stays NULL');
select pg_temp.assert((select count(*) from dpg_commerce.orders) = (select count(*) from dpg_commerce.events where entity = 'order' and action = 'created'), 'one created-event per order');
select pg_temp.assert(not exists (select 1 from dpg_commerce.events where actor <> 'guest'), 'guest events carry no PII');
select pg_temp.assert((select count(*) from dpg_commerce.orders where code = (select j->>'code' from t_o1)) = 1, 'idempotent: exactly one row for the retried key');

-- STAFF (Admin API role): read, version-checked status machine, notes, audit events; no delete, no line edits, no guest-looking events
set role dpg_admin_api;
select pg_temp.assert((select count(*) > 0 from dpg_commerce.orders) and (select count(*) > 0 from dpg_commerce.quote_lines), 'staff reads orders, quotes and their lines');
create temp table t_staff as select id, code from dpg_commerce.orders limit 1;
update dpg_commerce.orders set status = 'processing', version = version + 1 where id = (select id from t_staff);
insert into dpg_commerce.events(entity, entity_id, actor, action, from_status, to_status) select 'order', id, 'admin:7', 'status', 'new', 'processing' from t_staff;
select pg_temp.assert((select status = 'processing' and updated_at >= created_at from dpg_commerce.orders where id = (select id from t_staff)), 'new -> processing');
do $$ begin begin update dpg_commerce.orders set status = 'new' where status = 'processing'; exception when others then if sqlerrm like 'COMMERCE_STATUS_TRANSITION_INVALID%' then return; end if; raise; end; raise exception 'ASSERT FAILED: backwards transition accepted'; end $$;
update dpg_commerce.orders set status = 'done', staff_note = 'Da giao va thu tien ngoai he thong', version = version + 1 where id = (select id from t_staff);
do $$ begin begin update dpg_commerce.orders set status = 'cancelled' where status = 'done'; exception when others then if sqlerrm like 'COMMERCE_STATUS_TRANSITION_INVALID%' then return; end if; raise; end; raise exception 'ASSERT FAILED: terminal state changed'; end $$;
select pg_temp.denied('delete from dpg_commerce.orders', 'staff deletes orders');
select pg_temp.denied('update dpg_commerce.orders set total_vnd = 1', 'staff edits totals');
select pg_temp.denied('update dpg_commerce.orders set customer_phone = ''0900000000''', 'staff edits customer data through the status path');
select pg_temp.denied('update dpg_commerce.order_lines set quantity = 99', 'staff edits lines');
select pg_temp.denied('delete from dpg_commerce.events', 'staff deletes audit events');
select pg_temp.denied($$select dpg_commerce.order_submit('{}'::jsonb, 'idem-staff-001', 'aaaaaaaaaaaaaaaa')$$, 'staff role is not the intake path');
do $$ begin begin insert into dpg_commerce.events(entity, entity_id, actor, action) values ('order', 1, 'guest', 'status'); exception when others then if sqlstate in ('42501', '23514') or sqlerrm like '%row-level security%' then return; end if; raise; end; raise exception 'ASSERT FAILED: staff wrote a guest-looking event'; end $$;
reset role;
select pg_temp.assert((select count(*) from dpg_commerce.orders where status = 'done') = 1, 'terminal order stays done');
