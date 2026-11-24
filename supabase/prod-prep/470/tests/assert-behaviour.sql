create function pg_temp.assert(cond bool, msg text) returns void language plpgsql as $$ begin if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if; end $$;
create function pg_temp.fails_with(stmt text, code text) returns void language plpgsql as $$
begin begin execute stmt; exception when others then if sqlerrm = code then return; end if; raise exception 'ASSERT FAILED: expected %, got %', code, sqlerrm; end; raise exception 'ASSERT FAILED: expected % but succeeded', code; end $$;
update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=1000000 where sku='VS-OK';
update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=2000000, promotional_price_vnd=1800000, online_voucher_amount_vnd=100000 where sku='VS-PROMO';
update dpg_app.products set canonical_price_status='CONTACT_VERIFIED' where sku='VS-CONTACT';
update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=900000 where sku='VS-OUT';
select set_config('request.jwt.claims','{"sub":"11111111-1111-1111-1111-111111111111"}',false);
set role authenticated;
create function pg_temp.order_(items jsonb, k text) returns jsonb language sql as $$ select public.runtime_order_create(jsonb_build_object('customer_name','T','customer_phone','0900000001','items',items), k, null) $$;
-- a) canonical, no promo/voucher: canonical price, legacy 111 ignored
select pg_temp.assert((pg_temp.order_('[{"productId":1,"quantity":2}]','key-a-000001')->>'total')::numeric=2000000,'a total');
select pg_temp.assert((select subtotal=2000000 and discount=0 and total=2000000 from dpg_app.orders order by id desc limit 1),'a order row');
select pg_temp.assert((select unit_price=1000000 and total_price=2000000 from dpg_app.order_items order by id desc limit 1),'a item uses canonical, not legacy 111');
-- b) promo + voucher x qty 3, deducted once
select pg_temp.assert((pg_temp.order_('[{"productId":2,"quantity":3}]','key-b-000001')->>'total')::numeric=5100000,'b total 5.4M - 300k');
select pg_temp.assert((select subtotal=5400000 and discount=300000 and total=5100000 from dpg_app.orders order by id desc limit 1),'b order row');
select pg_temp.assert((select unit_price=1800000 and total_price=5400000 from dpg_app.order_items order by id desc limit 1),'b item = promo price, voucher NOT in unit price');
-- c) idempotent replay does not deduct/create twice
select pg_temp.assert((pg_temp.order_('[{"productId":2,"quantity":3}]','key-b-000001')->>'total')::numeric=5100000,'c replay same total');
select pg_temp.assert((select count(*) from dpg_app.orders)=2,'c replay created no second order');
-- d) install option adds to goods, voucher still goods-only x qty
select pg_temp.assert((pg_temp.order_('[{"productId":2,"quantity":2,"installOption":"install"}]','key-d-000001')->>'total')::numeric=(2*(1800000+200000))-200000,'d install');
-- e) unverified / contact / out-of-stock sanitary never fall back to legacy
select pg_temp.fails_with($$select pg_temp.order_('[{"productId":3,"quantity":1}]','key-e-000001')$$,'PRODUCT_REQUIRES_QUOTE');
select pg_temp.fails_with($$select pg_temp.order_('[{"productId":4,"quantity":1}]','key-e-000002')$$,'PRODUCT_REQUIRES_QUOTE');
select pg_temp.fails_with($$select pg_temp.order_('[{"productId":6,"quantity":1}]','key-e-000003')$$,'PRODUCT_REQUIRES_QUOTE');
-- f) other category keeps legacy (sale 450000), no discount
select pg_temp.assert((pg_temp.order_('[{"productId":5,"quantity":2}]','key-f-000001')->>'total')::numeric=900000,'f legacy total');
select pg_temp.assert((select discount=0 and total=900000 from dpg_app.orders order by id desc limit 1),'f legacy row');
-- g) mixed cart: voucher only on the sanitary line
select pg_temp.assert((pg_temp.order_('[{"productId":2,"quantity":1},{"productId":5,"quantity":1}]','key-g-000001')->>'total')::numeric=(1800000+450000-100000),'g mixed');
-- quotes
create function pg_temp.quote_(items jsonb, k text) returns jsonb language sql as $$ select public.runtime_quote_create(jsonb_build_object('name','T','phone','0900000001','products',items), k, null) $$;
select pg_temp.quote_('[{"product_id":1},{"product_id":2},{"product_id":3},{"product_id":4},{"product_id":5}]','key-q-000001');
select pg_temp.assert((select list_price_snapshot=1000000 and sale_price_snapshot is null and commerce_mode_snapshot='CONTACT_FOR_QUOTE' from dpg_app.quote_items where product_id=1),'q1 canonical list, no promo');
select pg_temp.assert((select list_price_snapshot=2000000 and sale_price_snapshot=1800000 and commerce_mode_snapshot='PUBLIC_PRICE' from dpg_app.quote_items where product_id=2),'q2 canonical promo');
select pg_temp.assert((select list_price_snapshot is null and sale_price_snapshot is null and commerce_mode_snapshot='CONTACT_FOR_QUOTE' from dpg_app.quote_items where product_id=3),'q3 unverified: legacy 333 NOT snapshotted');
select pg_temp.assert((select list_price_snapshot is null and commerce_mode_snapshot='CONTACT_FOR_QUOTE' from dpg_app.quote_items where product_id=4),'q4 contact verified');
select pg_temp.assert((select list_price_snapshot=500000 and sale_price_snapshot=450000 and commerce_mode_snapshot='PUBLIC_PRICE' from dpg_app.quote_items where product_id=5),'q5 other category legacy');
reset role;

-- h) #470 scope = sanitary AND TOTO/INAX. INAX is canonical; another sanitary brand and inactive/unresolved never use a canonical or legacy price wrongly
reset role;
update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=1500000, promotional_price_vnd=1400000, online_voucher_amount_vnd=50000 where sku='VS-INAX';
update dpg_app.products set canonical_price_status='UNRESOLVED' where sku='VS-INAX-UNRES';
update dpg_app.products set canonical_price_status='PRICE_VERIFIED', regular_price_vnd=1200000 where sku='VS-INACTIVE';   -- inactive but priced: must still not be orderable
set role authenticated;
select pg_temp.assert((pg_temp.order_('[{"productId":7,"quantity":2}]','key-h-000001')->>'total')::numeric=2*1400000-2*50000,'h1 INAX canonical promo, voucher x qty once');
select pg_temp.assert((select unit_price=1400000 and total_price=2800000 from dpg_app.order_items order by id desc limit 1),'h1 INAX item = canonical promo, not legacy 777');
select pg_temp.assert((pg_temp.order_('[{"productId":8,"quantity":1}]','key-h-000002')->>'total')::numeric=650000,'h2 other sanitary brand keeps LEGACY sale price (not canonical, not blanket)');
select pg_temp.fails_with($$select pg_temp.order_('[{"productId":10,"quantity":1}]','key-h-000003')$$,'PRODUCT_REQUIRES_QUOTE');   -- INAX unresolved: legacy 888 never used
select pg_temp.fails_with($$select pg_temp.order_('[{"productId":9,"quantity":1}]','key-h-000004')$$,'PRODUCT_UNAVAILABLE');      -- inactive cannot be ordered even with a canonical price
select pg_temp.quote_('[{"product_id":7},{"product_id":8},{"product_id":10}]','key-q-000002');
select pg_temp.assert((select list_price_snapshot=1500000 and sale_price_snapshot=1400000 and commerce_mode_snapshot='PUBLIC_PRICE' from dpg_app.quote_items where product_id=7),'q7 INAX canonical promo snapshot');
select pg_temp.assert((select list_price_snapshot=700000 and sale_price_snapshot=650000 from dpg_app.quote_items where product_id=8),'q8 other brand legacy snapshot');
select pg_temp.assert((select list_price_snapshot is null and sale_price_snapshot is null and commerce_mode_snapshot='CONTACT_FOR_QUOTE' from dpg_app.quote_items where product_id=10),'q10 INAX unresolved: no legacy snapshot');
select pg_temp.fails_with($$select public.runtime_quote_create(jsonb_build_object('name','T','phone','0900000001','products','[{"product_id":9}]'::jsonb),'key-q-000003',null)$$,'PRODUCT_UNAVAILABLE');
