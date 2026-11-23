-- #446 (Claude, Backend/Infra lane): TEST ONLY. Replaces public.guest_order_request_create so that category
-- thiet-bi-ve-sinh reads the three canonical price columns (Hita exact SKU) and deducts the online voucher exactly once
-- (per unit x quantity, at order.discount); order_items.unit_price/total_price stay pre-voucher so cart/order totals never
-- deduct twice. Other categories run the unchanged legacy branch. Previous definition: 008_..._rollback.sql.
-- Requires 007 (grants for the function owner on the new columns and on categories/products.category_id).
begin;
do $$ begin
  if not exists (select 1 from dpg_control.target_contract where environment='preview_synthetic'
      and production_writes_allowed=false and production_data_allowed=false and production_credentials_allowed=false) then
    raise exception 'HITA_ORDER_FN_TARGET_NOT_TEST';
  end if;
  if not has_column_privilege('dpg_order_intake_function_owner','dpg_app.products','regular_price_vnd','select')
     or not has_column_privilege('dpg_order_intake_function_owner','dpg_app.categories','slug','select') then
    raise exception 'HITA_ORDER_FN_REQUIRES_007_GRANTS';
  end if;
end $$;

CREATE OR REPLACE FUNCTION public.guest_order_request_create(p_input jsonb, p_idempotency_key text, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'dpg_app'
 SET row_security TO 'on'
AS $function$
declare
  v_key_hash char(64);
  v_request_hash char(64);
  v_phone_hash char(64);
  v_existing dpg_app.guest_order_idempotency_records%rowtype;
  v_name text;
  v_phone text;
  v_email text;
  v_address text;
  v_note text;
  v_item jsonb;
  v_product record;
  v_selection_keys text[] := array[]::text[];
  v_public_selling_price numeric;
  v_list_price numeric;
  v_sale_price numeric;
  v_base_price numeric;
  v_online_discount numeric;
  v_effective_discount numeric;
  v_install_option text;
  v_installation_fee numeric;
  v_unit_price numeric;
  v_final_unit_price numeric;
  v_line_total numeric;
  v_subtotal numeric := 0;
  v_discount numeric := 0;
  v_order_total numeric := 0;
  v_order_id integer;
  v_order_number varchar(20);
  v_request_count integer;
  v_window_start timestamptz := date_trunc('minute', clock_timestamp());
  v_lines jsonb := '[]'::jsonb;
  v_line jsonb;
  v_safe_response jsonb;
  v_error_code text;
  v_vs_category integer;
  v_canonical boolean;
  v_voucher numeric;
begin
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 8 and 200 then
    raise exception 'INVALID_IDEMPOTENCY_KEY';
  end if;
  if jsonb_typeof(p_input) <> 'object'
     or jsonb_typeof(p_input -> 'items') <> 'array'
     or jsonb_array_length(p_input -> 'items') not between 1 and 20 then
    raise exception 'INVALID_INPUT';
  end if;

  v_name := btrim(coalesce(p_input ->> 'customer_name', ''));
  v_phone := regexp_replace(btrim(coalesce(p_input ->> 'customer_phone', '')), '[[:space:]().-]', '', 'g');
  v_email := btrim(coalesce(p_input ->> 'customer_email', ''));
  v_address := nullif(btrim(coalesce(p_input ->> 'customer_address', '')), '');
  v_note := nullif(btrim(coalesce(p_input ->> 'note', '')), '');
  if length(v_name) not between 1 and 200 then raise exception 'INVALID_CUSTOMER_NAME'; end if;
  if length(v_phone) not between 9 and 13 or v_phone !~ '^(\+84|0)(3|5|7|8|9)[0-9]{8}$' then
    raise exception 'INVALID_CUSTOMER_PHONE';
  end if;
  if v_email <> '' and (length(v_email) > 200 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'INVALID_CUSTOMER_EMAIL';
  end if;
  if v_address is not null and length(v_address) > 1000 then raise exception 'INVALID_CUSTOMER_ADDRESS'; end if;
  if v_note is not null and length(v_note) > 2000 then raise exception 'INVALID_NOTE'; end if;

  for v_item in select value from jsonb_array_elements(p_input -> 'items') loop
    if jsonb_typeof(v_item) <> 'object'
       or coalesce(v_item ->> 'productId', '') !~ '^[0-9]{1,10}$'
       or jsonb_typeof(v_item -> 'sku') is distinct from 'string'
       or length(btrim(v_item ->> 'sku')) not between 1 and 100
       or coalesce(v_item ->> 'quantity', '') !~ '^[0-9]{1,2}$' then
      raise exception 'INVALID_ITEM';
    end if;
    if (v_item ->> 'productId')::numeric > 2147483647 then raise exception 'INVALID_ITEM'; end if;
    if (v_item ->> 'quantity')::integer not between 1 and 99 then raise exception 'INVALID_QUANTITY'; end if;
    if v_item ? 'installOption' and v_item ->> 'installOption' is null then raise exception 'INVALID_INSTALL_OPTION'; end if;
    if coalesce(v_item ->> 'installOption', 'none') not in ('none', 'install', 'replace') then
      raise exception 'INVALID_INSTALL_OPTION';
    end if;
    if jsonb_build_array(
      (v_item ->> 'productId')::integer,
      btrim(v_item ->> 'sku'),
      coalesce(v_item ->> 'installOption', 'none')
    )::text = any(v_selection_keys) then raise exception 'DUPLICATE_PRODUCT'; end if;
    v_selection_keys := array_append(v_selection_keys, jsonb_build_array(
      (v_item ->> 'productId')::integer,
      btrim(v_item ->> 'sku'),
      coalesce(v_item ->> 'installOption', 'none')
    )::text);
  end loop;

  v_key_hash := dpg_app.runtime_key_hash(btrim(p_idempotency_key));
  v_request_hash := dpg_app.runtime_hash(p_input);
  perform pg_advisory_xact_lock(hashtextextended('dpg:guest-order:idempotency:' || v_key_hash, 0));
  select request_hash, safe_response into v_existing.request_hash, v_existing.safe_response
    from dpg_app.guest_order_idempotency_records
   where key_hash = v_key_hash;
  if found then
    if v_existing.request_hash <> v_request_hash then
      return jsonb_build_object('error', 'IDEMPOTENCY_KEY_REUSED');
    end if;
    return v_existing.safe_response;
  end if;

  v_phone_hash := dpg_app.runtime_key_hash(v_phone);
  perform pg_advisory_xact_lock(hashtextextended('dpg:guest-order:rate:' || v_phone_hash, 0));
  with expired_windows as (
    select phone_hash, window_start
    from dpg_app.guest_order_rate_limit_windows
    where window_start < now() - interval '1 hour'
    order by window_start
    limit 500
  )
  delete from dpg_app.guest_order_rate_limit_windows r
  using expired_windows e
  where r.phone_hash = e.phone_hash and r.window_start = e.window_start;
  insert into dpg_app.guest_order_rate_limit_windows (phone_hash, window_start, request_count)
  values (v_phone_hash, v_window_start, 1)
  on conflict (phone_hash, window_start) do update
    set request_count = dpg_app.guest_order_rate_limit_windows.request_count + 1
  returning request_count into v_request_count;
  if v_request_count > 3 then
    return jsonb_build_object('error', 'ORDER_RATE_LIMITED');
  end if;

  -- Keep the rate-limit increment outside this subtransaction. Known request
  -- failures roll back all order writes while retaining the abuse counter.
  begin
    select id into v_vs_category from dpg_app.categories where slug = 'thiet-bi-ve-sinh';
    for v_item in select value from jsonb_array_elements(p_input -> 'items') loop
      select id, sku, name, price, original_price, list_price, sale_price,
        online_discount_amount, stock_status, price_source, source_system,
        price_state, price_confidence, price_updated_at,
        category_id, regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd
        into v_product
      from dpg_app.products
      where id = (v_item ->> 'productId')::integer
        and sku = btrim(v_item ->> 'sku')
        and is_active
        and publication_status = 'public'
        and pdp_visibility = 'public'
        and sellable_status = 'sellable'
        -- Availability is reconfirmed by staff; these states may create only
        -- a pending request, never an accepted or fulfilled order.
        and stock_status in ('in_stock', 'pre_order', 'preorder', 'contact');
      if not found then raise exception 'PRODUCT_UNAVAILABLE'; end if;

      -- #446 canonical branch: category thiet-bi-ve-sinh reads ONLY the three canonical columns (Hita exact SKU).
      -- No fallback to legacy price/list_price/sale_price/online_discount_amount. Other categories keep the legacy branch.
      v_canonical := v_vs_category is not null and v_product.category_id = v_vs_category;
      if v_canonical then
        if v_product.regular_price_vnd is null then raise exception 'PRODUCT_REQUIRES_QUOTE'; end if;
        v_list_price := v_product.regular_price_vnd;
        v_base_price := coalesce(v_product.promotional_price_vnd, v_product.regular_price_vnd);
        v_sale_price := v_product.promotional_price_vnd;
        v_voucher := case when v_product.online_voucher_amount_vnd > 0
          and v_product.online_voucher_amount_vnd < v_base_price then v_product.online_voucher_amount_vnd else null end;
        v_effective_discount := coalesce(v_voucher, 0);
        v_install_option := coalesce(v_item ->> 'installOption', 'none');
        v_installation_fee := case v_install_option when 'none' then 0 else null end;
        v_unit_price := v_base_price;
        v_final_unit_price := case when v_voucher is null then null else v_base_price - v_voucher end;
        v_line_total := v_unit_price * (v_item ->> 'quantity')::integer;
        v_subtotal := v_subtotal + v_line_total;
        -- Voucher is deducted exactly once: per unit x quantity, ONLY at order level (unit/total_price stay pre-voucher).
        v_discount := v_discount + v_effective_discount * (v_item ->> 'quantity')::integer;
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
          'product_id', v_product.id,
          'product_name', case v_install_option
            when 'install' then v_product.name || ' (Cần Lắp Đặt)'
            when 'replace' then v_product.name || ' (Tháo dỡ & Lắp Đặt)'
            else v_product.name end,
          'product_sku', v_product.sku,
          'quantity', (v_item ->> 'quantity')::integer,
          'unit_price', v_unit_price,
          'total_price', v_line_total,
          'commercial_snapshot', jsonb_build_object(
            'price_contract', 'canonical_vnd_v1',
            'regular_price_vnd', v_list_price,
            'promotional_price_vnd', v_sale_price,
            'online_voucher_amount_vnd', v_voucher,
            'list_price', v_list_price,
            'sale_price', v_sale_price,
            'online_discount_amount', v_voucher,
            'installation_fee', v_installation_fee,
            'installation_fee_status', case when v_install_option = 'none' then 'not_applicable' else 'pending_confirmation' end,
            'install_option', v_install_option,
            'final_unit_price', v_final_unit_price,
            'snapshot_at', clock_timestamp()
          )
        ));
        continue;
      end if;

      -- Match the frozen Public price allowlist: exact source identity,
      -- priced/high-confidence facts from 2026-07-02, and positive integer VND.
      -- Hita prices remain authoritative when optional comparison fields differ;
      -- manual prices additionally require matching list/original and sale facts.
      v_public_selling_price := case
        when dpg_control.phase2_preview_synthetic_product_eligible(v_product.id) then v_product.price
        when v_product.price_source in ('hita', 'manual')
          and v_product.source_system = v_product.price_source
          and v_product.price_state = 'priced'
          and v_product.price_confidence = 'high'
          and v_product.price_updated_at is not null
          and (v_product.price_updated_at at time zone 'UTC')::date = date '2026-07-02'
          and v_product.price is not null
          and v_product.price > 0
          and v_product.price <= 1000000000
          and v_product.price = trunc(v_product.price)
          and (
            v_product.price_source = 'hita'
            or (
              v_product.sale_price = v_product.price
              and v_product.list_price is not null
              and v_product.list_price > 0
              and v_product.list_price <= 1000000000
              and v_product.list_price = trunc(v_product.list_price)
              and v_product.list_price >= v_product.price
              and v_product.original_price = v_product.list_price
            )
          )
          then v_product.price
        else null end;
      if v_public_selling_price is null then
        raise exception 'PRODUCT_REQUIRES_QUOTE';
      end if;

      v_list_price := case
        when v_product.list_price is not null
          and v_product.original_price = v_product.list_price
          and v_product.list_price >= v_public_selling_price
          and v_product.list_price <= 1000000000
          and v_product.list_price = trunc(v_product.list_price)
          then v_product.list_price
        else v_public_selling_price end;
      v_sale_price := case
        when v_public_selling_price < v_list_price then v_public_selling_price
        else null end;
      v_base_price := v_public_selling_price;
      v_online_discount := case
        when v_product.online_discount_amount > 0
          and v_product.online_discount_amount <= 1000000000
          and v_product.online_discount_amount = trunc(v_product.online_discount_amount)
          and v_product.online_discount_amount < v_base_price then v_product.online_discount_amount
        else null end;
      v_effective_discount := coalesce(v_online_discount, 0);
      v_install_option := coalesce(v_item ->> 'installOption', 'none');
      v_installation_fee := case v_install_option
        when 'none' then 0
        else null end;
      v_unit_price := v_base_price;
      v_final_unit_price := case when v_online_discount is null then null
        else v_base_price - v_online_discount end;
      v_line_total := v_unit_price * (v_item ->> 'quantity')::integer;
      v_subtotal := v_subtotal + v_line_total;
      v_discount := v_discount + v_effective_discount * (v_item ->> 'quantity')::integer;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'product_id', v_product.id,
        'product_name', case v_install_option
          when 'install' then v_product.name || ' (Cần Lắp Đặt)'
          when 'replace' then v_product.name || ' (Tháo dỡ & Lắp Đặt)'
          else v_product.name end,
        'product_sku', v_product.sku,
        'quantity', (v_item ->> 'quantity')::integer,
        'unit_price', v_unit_price,
        'total_price', v_line_total,
        'commercial_snapshot', jsonb_build_object(
          'list_price', v_list_price,
          'sale_price', v_sale_price,
          'online_discount_amount', v_online_discount,
          'installation_fee', v_installation_fee,
          'installation_fee_status', case when v_install_option = 'none' then 'not_applicable' else 'pending_confirmation' end,
          'install_option', v_install_option,
          'final_unit_price', v_final_unit_price,
          'snapshot_at', clock_timestamp()
        )
      ));
    end loop;

    v_order_total := v_subtotal - v_discount;
    v_order_id := nextval('dpg_app.orders_id_seq');
    v_order_number := ('DPG-' || to_char(clock_timestamp(), 'YYMMDD') || '-' || upper(lpad(to_hex(v_order_id), 8, '0')))::varchar(20);
    insert into dpg_app.orders (
      id, owner_id, order_number, customer_name, customer_phone, customer_email,
      customer_address, note, subtotal, discount, total, status, payment_status,
      order_origin, shipping_fee_status
    ) values (
      v_order_id, null, v_order_number, v_name, v_phone, nullif(v_email, ''),
      v_address, v_note, v_subtotal, v_discount, v_order_total, 'pending', 'unpaid',
      'public_web', 'pending_confirmation'
    );

    for v_line in select value from jsonb_array_elements(v_lines) loop
      insert into dpg_app.order_items (
        order_id, product_id, product_name, product_sku, quantity,
        unit_price, total_price, commercial_snapshot
      ) values (
        v_order_id, (v_line ->> 'product_id')::integer,
        left(v_line ->> 'product_name', 500), left(v_line ->> 'product_sku', 100),
        (v_line ->> 'quantity')::integer, (v_line ->> 'unit_price')::numeric,
        (v_line ->> 'total_price')::numeric, v_line -> 'commercial_snapshot'
      );
    end loop;

    v_safe_response := jsonb_build_object(
      'order_number', v_order_number,
      'status', 'pending',
      'payment_status', 'unpaid'
    );
    insert into dpg_app.guest_order_idempotency_records (
      key_hash, request_hash, safe_response
    ) values (
      v_key_hash, v_request_hash, v_safe_response
    );
    return v_safe_response;
  exception when others then
    v_error_code := SQLERRM;
    if v_error_code in (
      'INVALID_INPUT', 'INVALID_CUSTOMER_NAME', 'INVALID_CUSTOMER_PHONE',
      'INVALID_CUSTOMER_EMAIL', 'INVALID_CUSTOMER_ADDRESS', 'INVALID_NOTE',
      'INVALID_ITEM', 'INVALID_QUANTITY', 'DUPLICATE_PRODUCT',
      'INVALID_INSTALL_OPTION', 'PRODUCT_UNAVAILABLE', 'PRODUCT_REQUIRES_QUOTE',
      'IDEMPOTENCY_KEY_REUSED'
    ) then
      return jsonb_build_object('error', v_error_code);
    end if;
    raise exception 'ORDER_REQUEST_FAILED';
  end;
end;
$function$;

commit;
