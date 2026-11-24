-- #470 DRAFT — rollback of 003: restores the live baseline text captured read-only on 2026-11-24.
-- After running, md5(pg_get_functiondef(...)) must equal a3c83a9ba45a709fdc0b23efd6aa07d8 (order) and
-- 2de47a88ea642102d471cb957e4ff930 (quote); verify before declaring rollback done.
-- Orders created while 003 was live keep their stored discount/total (data is not rewritten).
begin;
set local lock_timeout = '5s';
select set_config('dpg.price_release_go', :'approved_sha', true);
do $$ begin
  if coalesce(current_setting('dpg.price_release_go', true), '') = '' then raise exception 'PRICE_RELEASE_NO_OWNER_GO'; end if;
  if not exists (select 1 from dpg_control.target_contract where project_name = 'dongphugia-runtime' and region = 'ap-southeast-1' and environment = 'preview' and hard_database_ceiling_bytes = 367001600) then
    raise exception 'PRICE_RELEASE_TARGET_NOT_PRODUCTION_CONTRACT';
  end if;
end $$;

CREATE OR REPLACE FUNCTION public.runtime_order_create(p_input jsonb, p_idempotency_key text, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'dpg_app'
AS $function$
declare
  v_owner uuid := (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
  v_request_hash char(64);
  v_key_hash char(64);
  v_existing dpg_app.runtime_idempotency_records%rowtype;
  v_name text;
  v_phone text;
  v_email text;
  v_address text;
  v_note text;
  v_item jsonb;
  v_product record;
  v_install_option text;
  v_list_price numeric;
  v_unit_price numeric;
  v_line_total numeric;
  v_subtotal numeric := 0;
  v_lines jsonb := '[]'::jsonb;
  v_product_ids integer[] := array[]::integer[];
  v_order_id integer;
  v_order_number varchar(20);
  v_response jsonb;
begin
  if v_owner is null then raise exception 'UNAUTHORIZED'; end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 8 and 200 then
    raise exception 'INVALID_IDEMPOTENCY_KEY';
  end if;
  if jsonb_typeof(p_input) <> 'object' then raise exception 'INVALID_INPUT'; end if;
  if jsonb_typeof(p_input->'items') <> 'array'
     or jsonb_array_length(p_input->'items') not between 1 and 20 then
    raise exception 'INVALID_ITEMS';
  end if;

  v_key_hash := dpg_app.runtime_key_hash(btrim(p_idempotency_key));
  v_request_hash := dpg_app.runtime_hash(p_input);
  perform pg_advisory_xact_lock(hashtextextended(
    'leo541:idempotency:' || v_owner::text || ':order_create:' || v_key_hash, 0
  ));
  delete from dpg_app.runtime_idempotency_records
   where owner_id = v_owner and operation = 'order.create'
     and key_hash = v_key_hash and expires_at < now();
  insert into dpg_app.runtime_idempotency_records (
    owner_id, operation, key_hash, request_hash, safe_response,
    resource_type, resource_id, expires_at
  ) values (
    v_owner, 'order.create', v_key_hash, v_request_hash, '{}'::jsonb,
    'order', 'pending', now() + interval '24 hours'
  ) on conflict (owner_id, operation, key_hash) do nothing;
  if not found then
    select * into v_existing from dpg_app.runtime_idempotency_records
     where owner_id = v_owner and operation = 'order.create' and key_hash = v_key_hash;
    if v_existing.request_hash <> v_request_hash then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if;
    if v_existing.safe_response = '{}'::jsonb then raise exception 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_existing.safe_response;
  end if;

  v_name := btrim(coalesce(p_input->>'customer_name', ''));
  v_phone := btrim(coalesce(p_input->>'customer_phone', ''));
  v_email := btrim(coalesce(p_input->>'customer_email', ''));
  v_address := nullif(btrim(coalesce(p_input->>'customer_address', '')), '');
  v_note := nullif(btrim(coalesce(p_input->>'note', '')), '');
  if length(v_name) not between 1 and 200 then raise exception 'INVALID_CUSTOMER_NAME'; end if;
  if length(v_phone) not between 9 and 20 or v_phone !~ '^[0-9\s+().-]+$' then raise exception 'INVALID_CUSTOMER_PHONE'; end if;
  if v_email <> '' and (length(v_email) > 200 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then raise exception 'INVALID_CUSTOMER_EMAIL'; end if;
  if v_address is not null and length(v_address) > 1000 then raise exception 'INVALID_CUSTOMER_ADDRESS'; end if;
  if v_note is not null and length(v_note) > 2000 then raise exception 'INVALID_NOTE'; end if;

  for v_item in select value from jsonb_array_elements(p_input->'items') loop
    if jsonb_typeof(v_item) <> 'object'
       or (v_item->>'productId') is null
       or (v_item->>'quantity') is null
       or (v_item->>'productId') !~ '^[0-9]+$'
       or (v_item->>'quantity') !~ '^[0-9]+$' then
      raise exception 'INVALID_ITEM';
    end if;
    if (v_item->>'quantity')::integer not between 1 and 99 then raise exception 'INVALID_QUANTITY'; end if;
    if (v_item->>'productId')::integer = any(v_product_ids) then raise exception 'DUPLICATE_PRODUCT'; end if;
    v_product_ids := array_append(v_product_ids, (v_item->>'productId')::integer);
    if v_item ? 'installOption' and v_item->>'installOption' is null then raise exception 'INVALID_INSTALL_OPTION'; end if;
    v_install_option := coalesce(v_item->>'installOption', 'none');
    if v_install_option not in ('none', 'install', 'replace') then raise exception 'INVALID_INSTALL_OPTION'; end if;
    select id, sku, name, price, original_price, list_price, sale_price, stock_status
      into v_product from dpg_app.products
     where id = (v_item->>'productId')::integer
       and is_active
       and stock_status <> 'discontinued'
       and sellable_status = 'sellable'
       and publication_status = 'public'
       and pdp_visibility = 'public';
    if not found then raise exception 'PRODUCT_UNAVAILABLE'; end if;
    v_list_price := case
      when v_product.list_price is not null and v_product.list_price > 0 then v_product.list_price
      when v_product.original_price is not null and v_product.original_price > 0 then v_product.original_price
      when v_product.price is not null and v_product.price > 0 then v_product.price
      else null end;
    if v_product.stock_status <> 'in_stock' or v_list_price is null
       or v_product.list_price is null or v_product.list_price <= 0
       or (v_product.sale_price is not null and (v_product.sale_price <= 0 or v_product.sale_price >= v_list_price)) then
      raise exception 'PRODUCT_REQUIRES_QUOTE';
    end if;
    v_unit_price := round((coalesce(v_product.sale_price, v_product.list_price)
      + case v_install_option when 'install' then 200000 when 'replace' then 350000 else 0 end)::numeric, 2);
    v_line_total := v_unit_price * (v_item->>'quantity')::integer;
    v_subtotal := v_subtotal + v_line_total;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id', v_product.id,
      'product_name', case v_install_option when 'install' then v_product.name || ' (Cần Lắp Đặt)' when 'replace' then v_product.name || ' (Tháo dỡ & Lắp Đặt)' else v_product.name end,
      'product_sku', v_product.sku,
      'quantity', (v_item->>'quantity')::integer,
      'unit_price', v_unit_price,
      'total_price', v_line_total
    ));
  end loop;

  v_order_id := nextval('dpg_app.orders_id_seq');
  v_order_number := ('DPG-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' || lpad(v_order_id::text, 6, '0'))::varchar(20);
  insert into dpg_app.orders (
    id, owner_id, order_number, customer_name, customer_phone, customer_email,
    customer_address, note, subtotal, total, status, payment_status
  ) values (
    v_order_id, v_owner, v_order_number, v_name, v_phone, nullif(v_email, ''),
    v_address, v_note, v_subtotal, v_subtotal, 'pending', 'unpaid'
  );
  for v_item in select value from jsonb_array_elements(v_lines) loop
    insert into dpg_app.order_items (
      order_id, product_id, product_name, product_sku, quantity, unit_price, total_price
    ) values (
      v_order_id, (v_item->>'product_id')::integer, left(v_item->>'product_name', 500),
      left(v_item->>'product_sku', 100), (v_item->>'quantity')::integer,
      (v_item->>'unit_price')::numeric, (v_item->>'total_price')::numeric
    );
  end loop;
  v_response := jsonb_build_object('order_id', v_order_id, 'order_number', v_order_number, 'total', v_subtotal);
  insert into dpg_app.runtime_audit_events (
    owner_id, actor_id, operation, resource_type, resource_id, request_id,
    idempotency_key_hash, changed_fields, metadata
  ) values (
    v_owner, v_owner, 'order.create', 'order', v_order_id::text, p_request_id,
    v_key_hash, array['created'], jsonb_build_object('item_count', jsonb_array_length(v_lines))
  );
  update dpg_app.runtime_idempotency_records
     set safe_response = v_response, resource_id = v_order_id::text
   where owner_id = v_owner and operation = 'order.create' and key_hash = v_key_hash;
  return v_response;
end;
$function$;

CREATE OR REPLACE FUNCTION public.runtime_quote_create(p_input jsonb, p_idempotency_key text, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'dpg_app'
AS $function$
declare
  v_owner uuid := (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
  v_key_hash char(64); v_request_hash char(64); v_existing dpg_app.runtime_idempotency_records%rowtype;
  v_name text; v_phone text; v_email text; v_message text; v_item jsonb; v_product record;
  v_quote_id integer; v_quote_number varchar(30); v_snapshot_at timestamptz := now(); v_response jsonb;
  v_list_price numeric; v_sale_price numeric; v_mode text; v_availability text; v_count integer := 0;
begin
  if v_owner is null then raise exception 'UNAUTHORIZED'; end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 8 and 200 then raise exception 'INVALID_IDEMPOTENCY_KEY'; end if;
  if jsonb_typeof(p_input) <> 'object' then raise exception 'INVALID_INPUT'; end if;
  if jsonb_typeof(coalesce(p_input->'products', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_input->'products', '[]'::jsonb)) > 20 then
    raise exception 'INVALID_ITEMS';
  end if;
  v_key_hash := dpg_app.runtime_key_hash(btrim(p_idempotency_key)); v_request_hash := dpg_app.runtime_hash(p_input);
  perform pg_advisory_xact_lock(hashtextextended('leo541:idempotency:' || v_owner::text || ':quote_create:' || v_key_hash, 0));
  delete from dpg_app.runtime_idempotency_records where owner_id=v_owner and operation='quote.create' and key_hash=v_key_hash and expires_at<now();
  insert into dpg_app.runtime_idempotency_records(owner_id,operation,key_hash,request_hash,safe_response,resource_type,resource_id,expires_at)
    values(v_owner,'quote.create',v_key_hash,v_request_hash,'{}'::jsonb,'quote','pending',now()+interval '24 hours')
    on conflict(owner_id,operation,key_hash) do nothing;
  if not found then
    select * into v_existing from dpg_app.runtime_idempotency_records where owner_id=v_owner and operation='quote.create' and key_hash=v_key_hash;
    if v_existing.request_hash<>v_request_hash then raise exception 'IDEMPOTENCY_KEY_REUSED'; end if;
    if v_existing.safe_response='{}'::jsonb then raise exception 'IDEMPOTENCY_IN_PROGRESS'; end if;
    return v_existing.safe_response;
  end if;
  v_name:=btrim(coalesce(p_input->>'name','')); v_phone:=btrim(coalesce(p_input->>'phone','')); v_email:=btrim(coalesce(p_input->>'email','')); v_message:=nullif(btrim(coalesce(p_input->>'message','')),'');
  if length(v_name) < 1 then raise exception 'INVALID_CUSTOMER_NAME'; end if;
  if length(v_phone) not between 9 and 15 or v_phone !~ '^[0-9\s+().-]+$' then raise exception 'INVALID_CUSTOMER_PHONE'; end if;
  if v_email<>'' and (length(v_email)>255 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then raise exception 'INVALID_CUSTOMER_EMAIL'; end if;
  if v_message is not null and length(v_message)>2000 then raise exception 'INVALID_MESSAGE'; end if;
  v_quote_id:=nextval('dpg_app.quote_requests_id_seq'); v_quote_number:=('DPG-Q-'||to_char(clock_timestamp(),'YYYYMMDD')||'-'||lpad(v_quote_id::text,6,'0'))::varchar(30);
  insert into dpg_app.quote_requests(id,owner_id,name,phone,email,message,quote_number,status) values(v_quote_id,v_owner,v_name,v_phone,nullif(v_email,''),v_message,v_quote_number,'pending');
  for v_item in select value from jsonb_array_elements(coalesce(p_input->'products', '[]'::jsonb)) loop
    if jsonb_typeof(v_item)<>'object'
       or (v_item->>'product_id') is null
       or (v_item ? 'quantity' and v_item->>'quantity' is null)
       or (v_item->>'product_id') !~ '^[0-9]+$'
       or coalesce(v_item->>'quantity','1') !~ '^[0-9]+$'
       or coalesce((v_item->>'quantity')::integer,1) not between 1 and 99 then
      raise exception 'INVALID_ITEM';
    end if;
    select id,sku,name,price,original_price,list_price,sale_price,stock_status into v_product from dpg_app.products
     where id=(v_item->>'product_id')::integer
       and is_active
       and stock_status <> 'discontinued'
       and sellable_status = 'sellable'
       and publication_status = 'public'
       and pdp_visibility = 'public';
    if not found then raise exception 'PRODUCT_UNAVAILABLE'; end if;
    v_availability:=case v_product.stock_status when 'in_stock' then 'InStock' when 'pre_order' then 'PreOrder' when 'preorder' then 'PreOrder' when 'contact' then 'QuoteOnly' else null end;
    if v_availability is null then raise exception 'QUOTE_PRODUCT_NOT_QUOTEABLE'; end if;
    v_list_price:=case when v_product.list_price is not null and v_product.list_price>0 then v_product.list_price when v_product.original_price is not null and v_product.original_price>0 then v_product.original_price when v_product.price is not null and v_product.price>0 then v_product.price else null end;
    v_mode:='CONTACT_FOR_QUOTE'; v_sale_price:=null;
    if v_product.list_price is not null and v_product.list_price>0 and v_product.sale_price is not null and v_product.sale_price>0 and v_product.sale_price<v_product.list_price then v_mode:='PUBLIC_PRICE'; v_sale_price:=v_product.sale_price; end if;
    insert into dpg_app.quote_items(quote_id,product_id,quantity,note,product_sku_snapshot,product_name_snapshot,commerce_mode_snapshot,availability_snapshot,list_price_snapshot,sale_price_snapshot,snapshot_at)
      values(v_quote_id,v_product.id,coalesce((v_item->>'quantity')::integer,1),left(nullif(v_item->>'note',''),500),left(v_product.sku,100),left(v_product.name,500),v_mode,v_availability,v_list_price,v_sale_price,v_snapshot_at);
    v_count:=v_count+1;
  end loop;
  v_response:=jsonb_build_object('quote_id',v_quote_id,'quote_number',v_quote_number,'item_count',v_count);
  insert into dpg_app.runtime_audit_events(owner_id,actor_id,operation,resource_type,resource_id,request_id,idempotency_key_hash,changed_fields,metadata)
    values(v_owner,v_owner,'quote.create','quote',v_quote_id::text,p_request_id,v_key_hash,array['created'],jsonb_build_object('item_count',v_count));
  update dpg_app.runtime_idempotency_records set safe_response=v_response,resource_id=v_quote_id::text where owner_id=v_owner and operation='quote.create' and key_hash=v_key_hash;
  return v_response;
end;
$function$;

commit;
