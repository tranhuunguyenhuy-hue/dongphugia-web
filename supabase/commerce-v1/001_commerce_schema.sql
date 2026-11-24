-- #470 COMMERCE V1 — NEW order + quote persistence and guest intake functions. DRAFT, NOT APPLIED to Production.
-- Owner decision 24/11: rebuild ordering/quoting from scratch; the legacy dpg_app.orders/order_items/quote_requests/quote_items and runtime_* RPCs are NOT reused.
-- Everything lives in the new schema `dpg_commerce` (distinct names). Guests never touch tables: the Worker connects with a login role that can only SET ROLE to
-- `dpg_commerce_intake`, which has EXECUTE on exactly three SECURITY DEFINER functions (cart_check, order_submit, quote_submit). Staff access is the Admin API role (:admin_role).
-- Prices are read here from dpg_app.products (the three canonical columns) — nothing a client sends about prices/discount/total is trusted (the client only echoes the total it SAW, to detect a change).
-- Usage (operator `postgres`, after Owner GO naming the exact SHA):
--   psql -v ON_ERROR_STOP=1 -v approved_sha=<sha> -v target=production|test -v admin_role=dpg_admin_api|dpg_admin_api_test -f 001_commerce_schema.sql
begin;
set local lock_timeout = '5s';
select set_config('dpg.commerce_go', :'approved_sha', true), set_config('dpg.commerce_target', :'target', true), set_config('dpg.commerce_admin_role', :'admin_role', true);
do $$
declare v_target text := current_setting('dpg.commerce_target', true);
begin
  if coalesce(current_setting('dpg.commerce_go', true), '') = '' then raise exception 'COMMERCE_NO_OWNER_GO'; end if;
  if v_target = 'production' then
    if not exists (select 1 from dpg_control.target_contract where project_name = 'dongphugia-runtime' and region = 'ap-southeast-1' and environment = 'preview' and hard_database_ceiling_bytes = 367001600) then
      raise exception 'COMMERCE_TARGET_NOT_PRODUCTION_CONTRACT'; end if;
  elsif v_target = 'test' then
    if not exists (select 1 from dpg_control.target_contract where project_name = 'dongphugia-phase2-preview-290' and region = 'ap-southeast-1' and environment = 'preview_synthetic'
        and not production_writes_allowed and not production_data_allowed and not production_credentials_allowed) then raise exception 'COMMERCE_TARGET_NOT_TEST_CONTRACT'; end if;
  else raise exception 'COMMERCE_TARGET_UNKNOWN'; end if;
  if not exists (select 1 from pg_roles where rolname = current_setting('dpg.commerce_admin_role', true)) then raise exception 'COMMERCE_ADMIN_ROLE_MISSING'; end if;
  if (select count(*) from pg_attribute where attrelid = 'dpg_app.products'::regclass and not attisdropped
        and attname in ('regular_price_vnd','promotional_price_vnd','online_voucher_amount_vnd','canonical_price_status')) <> 4 then raise exception 'COMMERCE_REQUIRES_PRICE_COLUMNS'; end if;
end $$;

-- roles (NOLOGIN): the owner of tables/functions, and the only role guests can become
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'dpg_commerce_owner') then create role dpg_commerce_owner nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'dpg_commerce_intake') then create role dpg_commerce_intake nologin noinherit; end if;
end $$;
grant dpg_commerce_owner to current_user;   -- lets the operator create objects owned by it in this transaction (revoked below)
create schema if not exists dpg_commerce authorization dpg_commerce_owner;
revoke all on schema dpg_commerce from public;
-- security: the owner needs only to read the product facts above (forced RLS on dpg_app tables => explicit narrow policies for the owner)
grant usage on schema dpg_app to dpg_commerce_owner;
grant select (id, sku, name, is_active, publication_status, pdp_visibility, sellable_status, stock_status, category_id, brand_id, regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd, canonical_price_status)
  on dpg_app.products to dpg_commerce_owner;
grant select (id, slug, name) on dpg_app.brands to dpg_commerce_owner;
grant select (id, slug) on dpg_app.categories to dpg_commerce_owner;
do $$ begin
  if not exists (select 1 from pg_policy where polrelid = 'dpg_app.products'::regclass and polname = 'dpg_commerce_owner_select') then
    create policy dpg_commerce_owner_select on dpg_app.products for select to dpg_commerce_owner using (is_active and publication_status = 'public' and pdp_visibility = 'public'); end if;
  if not exists (select 1 from pg_policy where polrelid = 'dpg_app.brands'::regclass and polname = 'dpg_commerce_owner_select') then
    create policy dpg_commerce_owner_select on dpg_app.brands for select to dpg_commerce_owner using (true); end if;
  if not exists (select 1 from pg_policy where polrelid = 'dpg_app.categories'::regclass and polname = 'dpg_commerce_owner_select') then
    create policy dpg_commerce_owner_select on dpg_app.categories for select to dpg_commerce_owner using (true); end if;
end $$;
set local role dpg_commerce_owner;

create table dpg_commerce.orders (
  id bigint generated always as identity primary key,
  code text not null unique check (code ~ '^DH-[0-9A-F]{10}$'),
  status text not null default 'new' check (status in ('new', 'processing', 'done', 'cancelled')),
  customer_name text not null check (char_length(customer_name) between 2 and 120),
  customer_phone text not null check (customer_phone ~ '^0[35789][0-9]{8}$'),
  customer_email text check (customer_email is null or char_length(customer_email) <= 200),
  delivery_address text not null check (char_length(delivery_address) between 5 and 400),
  note text check (note is null or char_length(note) <= 1000),
  subtotal_vnd bigint not null check (subtotal_vnd > 0),
  voucher_vnd bigint not null default 0 check (voucher_vnd >= 0),
  total_vnd bigint not null check (total_vnd > 0 and total_vnd = subtotal_vnd - voucher_vnd),
  line_count integer not null check (line_count between 1 and 20),
  idempotency_hash text not null unique check (idempotency_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  staff_note text check (staff_note is null or char_length(staff_note) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table dpg_commerce.order_lines (
  id bigint generated always as identity primary key,
  order_id bigint not null references dpg_commerce.orders(id) on delete restrict,
  line_no integer not null check (line_no between 1 and 20),
  product_id integer not null,
  sku text not null, product_name text not null, brand text,
  quantity integer not null check (quantity between 1 and 99),
  regular_vnd bigint not null check (regular_vnd > 0),
  unit_selling_vnd bigint not null check (unit_selling_vnd > 0 and unit_selling_vnd <= regular_vnd),
  unit_voucher_vnd bigint not null default 0 check (unit_voucher_vnd >= 0 and unit_voucher_vnd < unit_selling_vnd),
  line_subtotal_vnd bigint not null check (line_subtotal_vnd = unit_selling_vnd * quantity),
  line_voucher_vnd bigint not null check (line_voucher_vnd = unit_voucher_vnd * quantity),
  unique (order_id, line_no), unique (order_id, product_id)
);
create table dpg_commerce.quotes (
  id bigint generated always as identity primary key,
  code text not null unique check (code ~ '^BG-[0-9A-F]{10}$'),
  status text not null default 'new' check (status in ('new', 'processing', 'done', 'cancelled')),
  customer_name text not null check (char_length(customer_name) between 2 and 120),
  customer_phone text not null check (customer_phone ~ '^0[35789][0-9]{8}$'),
  customer_email text check (customer_email is null or char_length(customer_email) <= 200),
  note text check (note is null or char_length(note) <= 1000),
  line_count integer not null check (line_count between 1 and 20),
  idempotency_hash text not null unique check (idempotency_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  staff_note text check (staff_note is null or char_length(staff_note) <= 2000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table dpg_commerce.quote_lines (
  id bigint generated always as identity primary key,
  quote_id bigint not null references dpg_commerce.quotes(id) on delete restrict,
  line_no integer not null check (line_no between 1 and 20),
  product_id integer not null,
  sku text not null, product_name text not null, brand text,
  quantity integer not null check (quantity between 1 and 99),
  reason text not null check (reason in ('NO_PRICE', 'QUOTE_ONLY', 'CUSTOMER_REQUEST')),
  unit_selling_vnd bigint check (unit_selling_vnd is null or unit_selling_vnd > 0),   -- reference snapshot only when an official price exists; NULL is NEVER 0
  unique (quote_id, line_no), unique (quote_id, product_id)
);
create table dpg_commerce.events (
  id bigint generated always as identity primary key,
  entity text not null check (entity in ('order', 'quote')),
  entity_id bigint not null,
  actor text not null check (char_length(actor) between 1 and 80),
  action text not null check (action in ('created', 'status', 'note')),
  from_status text, to_status text,
  at timestamptz not null default now()
);
create index on dpg_commerce.events (entity, entity_id, id);
create index on dpg_commerce.orders (status, created_at desc);
create index on dpg_commerce.quotes (status, created_at desc);
create table dpg_commerce.rate_buckets (
  bucket text not null, window_start timestamptz not null, hits integer not null default 0,
  primary key (bucket, window_start)
);

-- status machine (staff): new -> processing -> done ; new|processing -> cancelled. Terminal states never change. Every change bumps version/updated_at.
create function dpg_commerce.status_guard() returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if tg_op = 'UPDATE' then
    if new.status is distinct from old.status and not ((old.status = 'new' and new.status in ('processing', 'cancelled')) or (old.status = 'processing' and new.status in ('done', 'cancelled'))) then
      raise exception 'COMMERCE_STATUS_TRANSITION_INVALID % -> %', old.status, new.status; end if;
    if new.id is distinct from old.id or new.code is distinct from old.code or new.created_at is distinct from old.created_at or new.idempotency_hash is distinct from old.idempotency_hash then
      raise exception 'COMMERCE_IDENTITY_IMMUTABLE'; end if;
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger orders_status_guard before update on dpg_commerce.orders for each row execute function dpg_commerce.status_guard();
create trigger quotes_status_guard before update on dpg_commerce.quotes for each row execute function dpg_commerce.status_guard();
-- lines and events are append-only history
create function dpg_commerce.append_only() returns trigger language plpgsql set search_path = pg_catalog as $$ begin raise exception 'COMMERCE_APPEND_ONLY'; end $$;
create trigger order_lines_append_only before update or delete on dpg_commerce.order_lines for each row execute function dpg_commerce.append_only();
create trigger quote_lines_append_only before update or delete on dpg_commerce.quote_lines for each row execute function dpg_commerce.append_only();
create trigger events_append_only before update or delete on dpg_commerce.events for each row execute function dpg_commerce.append_only();

-- fixed-window counters; the caller returns business errors as JSON (not raise) so a counted hit survives the transaction
create function dpg_commerce.rate_hit(p_bucket text, p_window_secs integer, p_max integer) returns boolean language plpgsql security definer set search_path = pg_catalog, dpg_commerce as $$
declare v_start timestamptz := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_window_secs) * p_window_secs); v_hits integer;
begin
  delete from dpg_commerce.rate_buckets where window_start < now() - interval '2 days';
  insert into dpg_commerce.rate_buckets (bucket, window_start, hits) values (p_bucket, v_start, 1)
    on conflict (bucket, window_start) do update set hits = dpg_commerce.rate_buckets.hits + 1 returning hits into v_hits;
  return v_hits <= p_max;
end $$;

-- eligibility = the single definition of "may be bought directly": active public sanitary TOTO/INAX SKU with an official PRICE_VERIFIED price, sellable by DPG
create function dpg_commerce.product_snapshot(p_ids integer[]) returns table (
  id integer, sku text, name text, brand text, listed boolean, orderable boolean, reason text, regular_vnd bigint, selling_vnd bigint, voucher_vnd bigint
) language sql stable security definer set search_path = pg_catalog, dpg_commerce, dpg_app as $$
  select p.id, p.sku::text, p.name::text, b.name::text,
    coalesce(p.is_active and p.publication_status = 'public' and p.pdp_visibility = 'public', false) as listed,
    (e.ok) as orderable,
    case when not coalesce(p.is_active and p.publication_status = 'public' and p.pdp_visibility = 'public', false) then 'UNAVAILABLE'
         when e.ok then 'ORDERABLE'
         when p.sellable_status = 'quote_only' or p.sellable_status = 'not_sellable' or p.stock_status = 'discontinued' then 'QUOTE_ONLY'
         else 'NO_PRICE' end,
    case when e.ok then p.regular_price_vnd end,
    case when e.ok then coalesce(p.promotional_price_vnd, p.regular_price_vnd) end,
    case when e.ok and p.online_voucher_amount_vnd > 0 and p.online_voucher_amount_vnd < coalesce(p.promotional_price_vnd, p.regular_price_vnd) then p.online_voucher_amount_vnd else 0 end
  from dpg_app.products p
  left join dpg_app.brands b on b.id = p.brand_id
  left join dpg_app.categories c on c.id = p.category_id
  cross join lateral (select coalesce(p.is_active and p.publication_status = 'public' and p.pdp_visibility = 'public'
      and c.slug = 'thiet-bi-ve-sinh' and b.slug in ('toto', 'inax') and p.sellable_status = 'sellable' and p.stock_status <> 'discontinued'
      and p.canonical_price_status = 'PRICE_VERIFIED' and p.regular_price_vnd > 0
      and (p.promotional_price_vnd is null or (p.promotional_price_vnd > 0 and p.promotional_price_vnd < p.regular_price_vnd)), false) as ok) e
  where p.id = any(p_ids)
$$;

-- shared input validation: returns the cleaned items [{id, qty}] or raises a stable code
create function dpg_commerce.clean_items(p_items jsonb) returns jsonb language plpgsql immutable set search_path = pg_catalog as $$
declare v_item jsonb; v_ids integer[] := array[]::integer[]; v_out jsonb := '[]'::jsonb; v_id integer; v_qty integer;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 20 then raise exception 'INVALID_ITEMS'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object' or (v_item ->> 'productId') !~ '^[1-9][0-9]{0,8}$' or (v_item ->> 'quantity') !~ '^[1-9][0-9]?$' then raise exception 'INVALID_ITEM'; end if;
    v_id := (v_item ->> 'productId')::integer; v_qty := (v_item ->> 'quantity')::integer;
    if v_qty > 99 then raise exception 'INVALID_QUANTITY'; end if;
    if v_id = any(v_ids) then raise exception 'DUPLICATE_PRODUCT'; end if;
    v_ids := v_ids || v_id; v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'qty', v_qty));
  end loop;
  return v_out;
end $$;

create function dpg_commerce.new_code(p_prefix text) returns text language sql volatile set search_path = pg_catalog as $$
  select p_prefix || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
$$;

-- 1) cart_check: what the server will accept for this cart (read-only; used on the cart page and before checkout)
create function dpg_commerce.cart_check(p_items jsonb, p_ip_hash text) returns jsonb language plpgsql security definer set search_path = pg_catalog, dpg_commerce, dpg_app as $$
declare v_items jsonb; v_lines jsonb := '[]'::jsonb; v_row record; v_it jsonb; v_sub bigint := 0; v_vou bigint := 0; v_orders integer := 0; v_quotes integer := 0; v_un integer := 0; v_qty integer;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{16,64}$' then return jsonb_build_object('error', 'INVALID_INPUT'); end if;
  if not dpg_commerce.rate_hit('cart:' || p_ip_hash, 60, 120) then return jsonb_build_object('error', 'RATE_LIMITED'); end if;
  begin v_items := dpg_commerce.clean_items(p_items); exception when others then return jsonb_build_object('error', case when sqlerrm in ('INVALID_ITEMS', 'INVALID_ITEM', 'INVALID_QUANTITY', 'DUPLICATE_PRODUCT') then sqlerrm else 'INVALID_ITEMS' end); end;
  for v_it in select value from jsonb_array_elements(v_items) loop
    v_qty := (v_it ->> 'qty')::integer;
    select * into v_row from dpg_commerce.product_snapshot(array[(v_it ->> 'id')::integer]);
    if not found or not v_row.listed then
      v_un := v_un + 1; v_lines := v_lines || jsonb_build_array(jsonb_build_object('productId', (v_it ->> 'id')::integer, 'quantity', v_qty, 'mode', 'unavailable'));
    elsif v_row.orderable then
      v_orders := v_orders + 1; v_sub := v_sub + v_row.selling_vnd * v_qty; v_vou := v_vou + v_row.voucher_vnd * v_qty;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('productId', v_row.id, 'sku', v_row.sku, 'name', v_row.name, 'brand', v_row.brand, 'quantity', v_qty, 'mode', 'order',
        'regularVnd', v_row.regular_vnd, 'unitSellingVnd', v_row.selling_vnd, 'unitVoucherVnd', v_row.voucher_vnd, 'lineTotalVnd', (v_row.selling_vnd - v_row.voucher_vnd) * v_qty));
    else
      v_quotes := v_quotes + 1; v_lines := v_lines || jsonb_build_array(jsonb_build_object('productId', v_row.id, 'sku', v_row.sku, 'name', v_row.name, 'brand', v_row.brand, 'quantity', v_qty, 'mode', 'quote', 'reason', v_row.reason));
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'lines', v_lines, 'order', jsonb_build_object('count', v_orders, 'subtotalVnd', v_sub, 'voucherVnd', v_vou, 'totalVnd', v_sub - v_vou),
    'quoteCount', v_quotes, 'unavailableCount', v_un);
end $$;

-- common contact validation (returns cleaned fields or an error code)
create function dpg_commerce.clean_contact(p_in jsonb, p_need_address boolean) returns jsonb language plpgsql immutable set search_path = pg_catalog as $$
declare v_name text := btrim(coalesce(p_in ->> 'customerName', '')); v_phone text := regexp_replace(btrim(coalesce(p_in ->> 'customerPhone', '')), '[[:space:]().-]', '', 'g');
        v_email text := btrim(coalesce(p_in ->> 'customerEmail', '')); v_addr text := btrim(coalesce(p_in ->> 'deliveryAddress', '')); v_note text := btrim(coalesce(p_in ->> 'note', ''));
begin
  if jsonb_typeof(p_in -> 'customerName') is distinct from 'string' or char_length(v_name) not between 2 and 120 or v_name ~ '[[:cntrl:]]' then return jsonb_build_object('error', 'INVALID_CUSTOMER_NAME'); end if;
  if v_phone ~ '^(\+84|84)' then v_phone := '0' || regexp_replace(v_phone, '^(\+84|84)', ''); end if;
  if v_phone !~ '^0[35789][0-9]{8}$' then return jsonb_build_object('error', 'INVALID_CUSTOMER_PHONE'); end if;
  if v_email <> '' and (char_length(v_email) > 200 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or v_email ~ '[[:cntrl:]]') then return jsonb_build_object('error', 'INVALID_CUSTOMER_EMAIL'); end if;
  if p_need_address and (char_length(v_addr) not between 5 and 400 or v_addr ~ '[[:cntrl:]]') then return jsonb_build_object('error', 'INVALID_DELIVERY_ADDRESS'); end if;
  if char_length(v_note) > 1000 or v_note ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]' then return jsonb_build_object('error', 'INVALID_NOTE'); end if;
  return jsonb_build_object('name', v_name, 'phone', v_phone, 'email', nullif(v_email, ''), 'address', nullif(v_addr, ''), 'note', nullif(v_note, ''));
end $$;

-- 2) order_submit: direct purchase of ORDERABLE lines only. The client echoes the total it saw (expectedTotalVnd); a different server total => PRICE_CHANGED (nothing written).
create function dpg_commerce.order_submit(p_input jsonb, p_idempotency_key text, p_ip_hash text) returns jsonb language plpgsql security definer set search_path = pg_catalog, dpg_commerce, dpg_app as $$
declare
  v_idem text := btrim(coalesce(p_idempotency_key, '')); v_idem_hash text; v_req_hash text; v_contact jsonb; v_items jsonb; v_it jsonb; v_row record; v_qty integer;
  v_lines jsonb := '[]'::jsonb; v_bad integer[] := array[]::integer[]; v_nq integer[] := array[]::integer[]; v_sub bigint := 0; v_vou bigint := 0; v_expected bigint;
  v_existing record; v_id bigint; v_code text; v_n integer := 0; v_try integer := 0; v_l jsonb;
begin
  if v_idem !~ '^[A-Za-z0-9._:-]{8,100}$' then return jsonb_build_object('error', 'INVALID_IDEMPOTENCY_KEY'); end if;
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{16,64}$' or jsonb_typeof(p_input) is distinct from 'object' then return jsonb_build_object('error', 'INVALID_INPUT'); end if;
  if not dpg_commerce.rate_hit('ip:' || p_ip_hash, 600, 8) then return jsonb_build_object('error', 'RATE_LIMITED'); end if;
  v_contact := dpg_commerce.clean_contact(p_input, true); if v_contact ? 'error' then return v_contact; end if;
  if not dpg_commerce.rate_hit('phone:' || encode(sha256(convert_to(v_contact ->> 'phone', 'utf8')), 'hex'), 3600, 5) then return jsonb_build_object('error', 'RATE_LIMITED'); end if;
  begin v_items := dpg_commerce.clean_items(p_input -> 'items'); exception when others then return jsonb_build_object('error', case when sqlerrm in ('INVALID_ITEMS', 'INVALID_ITEM', 'INVALID_QUANTITY', 'DUPLICATE_PRODUCT') then sqlerrm else 'INVALID_ITEMS' end); end;
  if coalesce(p_input ->> 'expectedTotalVnd', '') !~ '^[1-9][0-9]{0,12}$' then return jsonb_build_object('error', 'INVALID_INPUT'); end if;
  v_expected := (p_input ->> 'expectedTotalVnd')::bigint;
  v_idem_hash := encode(sha256(convert_to(v_idem, 'utf8')), 'hex');
  v_req_hash := encode(sha256(convert_to((v_contact || jsonb_build_object('items', v_items, 'expected', v_expected))::text, 'utf8')), 'hex');
  perform pg_advisory_xact_lock(hashtextextended('commerce:order:' || v_idem_hash, 0));
  select id, code, status, subtotal_vnd, voucher_vnd, total_vnd, line_count, request_hash, created_at into v_existing from dpg_commerce.orders where idempotency_hash = v_idem_hash;
  if found then
    if v_existing.request_hash <> v_req_hash then return jsonb_build_object('error', 'IDEMPOTENCY_KEY_REUSED'); end if;
    return jsonb_build_object('ok', true, 'kind', 'order', 'replayed', true, 'code', v_existing.code, 'status', v_existing.status, 'subtotalVnd', v_existing.subtotal_vnd,
      'voucherVnd', v_existing.voucher_vnd, 'totalVnd', v_existing.total_vnd, 'lineCount', v_existing.line_count, 'createdAt', v_existing.created_at);
  end if;
  for v_it in select value from jsonb_array_elements(v_items) loop
    v_qty := (v_it ->> 'qty')::integer;
    select * into v_row from dpg_commerce.product_snapshot(array[(v_it ->> 'id')::integer]);
    if not found or not v_row.listed then v_bad := v_bad || (v_it ->> 'id')::integer;
    elsif not v_row.orderable then v_nq := v_nq || v_row.id;
    else
      v_n := v_n + 1; v_sub := v_sub + v_row.selling_vnd * v_qty; v_vou := v_vou + v_row.voucher_vnd * v_qty;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('n', v_n, 'id', v_row.id, 'sku', v_row.sku, 'name', v_row.name, 'brand', v_row.brand, 'qty', v_qty, 'regular', v_row.regular_vnd, 'selling', v_row.selling_vnd, 'voucher', v_row.voucher_vnd));
    end if;
  end loop;
  if cardinality(v_bad) > 0 then return jsonb_build_object('error', 'PRODUCT_UNAVAILABLE', 'productIds', to_jsonb(v_bad)); end if;
  if cardinality(v_nq) > 0 then return jsonb_build_object('error', 'ITEMS_NOT_ORDERABLE', 'productIds', to_jsonb(v_nq)); end if;
  if v_sub - v_vou <> v_expected then return jsonb_build_object('error', 'PRICE_CHANGED', 'totalVnd', v_sub - v_vou, 'subtotalVnd', v_sub, 'voucherVnd', v_vou); end if;
  loop
    v_code := dpg_commerce.new_code('DH'); v_try := v_try + 1;
    exit when not exists (select 1 from dpg_commerce.orders where code = v_code) or v_try > 5;
  end loop;
  insert into dpg_commerce.orders (code, customer_name, customer_phone, customer_email, delivery_address, note, subtotal_vnd, voucher_vnd, total_vnd, line_count, idempotency_hash, request_hash)
    values (v_code, v_contact ->> 'name', v_contact ->> 'phone', v_contact ->> 'email', v_contact ->> 'address', v_contact ->> 'note', v_sub, v_vou, v_sub - v_vou, v_n, v_idem_hash, v_req_hash) returning id into v_id;
  for v_l in select value from jsonb_array_elements(v_lines) loop
    insert into dpg_commerce.order_lines (order_id, line_no, product_id, sku, product_name, brand, quantity, regular_vnd, unit_selling_vnd, unit_voucher_vnd, line_subtotal_vnd, line_voucher_vnd)
      values (v_id, (v_l ->> 'n')::integer, (v_l ->> 'id')::integer, v_l ->> 'sku', v_l ->> 'name', v_l ->> 'brand', (v_l ->> 'qty')::integer, (v_l ->> 'regular')::bigint, (v_l ->> 'selling')::bigint,
        (v_l ->> 'voucher')::bigint, (v_l ->> 'selling')::bigint * (v_l ->> 'qty')::integer, (v_l ->> 'voucher')::bigint * (v_l ->> 'qty')::integer);
  end loop;
  insert into dpg_commerce.events (entity, entity_id, actor, action, to_status) values ('order', v_id, 'guest', 'created', 'new');
  return jsonb_build_object('ok', true, 'kind', 'order', 'code', v_code, 'status', 'new', 'subtotalVnd', v_sub, 'voucherVnd', v_vou, 'totalVnd', v_sub - v_vou, 'lineCount', v_n, 'createdAt', now());
end $$;

-- 3) quote_submit: any ACTIVE public product can be asked for a quote (a reference price is stored only when an official price exists)
create function dpg_commerce.quote_submit(p_input jsonb, p_idempotency_key text, p_ip_hash text) returns jsonb language plpgsql security definer set search_path = pg_catalog, dpg_commerce, dpg_app as $$
declare
  v_idem text := btrim(coalesce(p_idempotency_key, '')); v_idem_hash text; v_req_hash text; v_contact jsonb; v_items jsonb; v_it jsonb; v_row record; v_qty integer;
  v_lines jsonb := '[]'::jsonb; v_bad integer[] := array[]::integer[]; v_existing record; v_id bigint; v_code text; v_n integer := 0; v_try integer := 0; v_l jsonb;
begin
  if v_idem !~ '^[A-Za-z0-9._:-]{8,100}$' then return jsonb_build_object('error', 'INVALID_IDEMPOTENCY_KEY'); end if;
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{16,64}$' or jsonb_typeof(p_input) is distinct from 'object' then return jsonb_build_object('error', 'INVALID_INPUT'); end if;
  if not dpg_commerce.rate_hit('ip:' || p_ip_hash, 600, 8) then return jsonb_build_object('error', 'RATE_LIMITED'); end if;
  v_contact := dpg_commerce.clean_contact(p_input, false); if v_contact ? 'error' then return v_contact; end if;
  if not dpg_commerce.rate_hit('phone:' || encode(sha256(convert_to(v_contact ->> 'phone', 'utf8')), 'hex'), 3600, 5) then return jsonb_build_object('error', 'RATE_LIMITED'); end if;
  begin v_items := dpg_commerce.clean_items(p_input -> 'items'); exception when others then return jsonb_build_object('error', case when sqlerrm in ('INVALID_ITEMS', 'INVALID_ITEM', 'INVALID_QUANTITY', 'DUPLICATE_PRODUCT') then sqlerrm else 'INVALID_ITEMS' end); end;
  v_idem_hash := encode(sha256(convert_to(v_idem, 'utf8')), 'hex');
  v_req_hash := encode(sha256(convert_to((v_contact || jsonb_build_object('items', v_items))::text, 'utf8')), 'hex');
  perform pg_advisory_xact_lock(hashtextextended('commerce:quote:' || v_idem_hash, 0));
  select id, code, status, line_count, request_hash, created_at into v_existing from dpg_commerce.quotes where idempotency_hash = v_idem_hash;
  if found then
    if v_existing.request_hash <> v_req_hash then return jsonb_build_object('error', 'IDEMPOTENCY_KEY_REUSED'); end if;
    return jsonb_build_object('ok', true, 'kind', 'quote', 'replayed', true, 'code', v_existing.code, 'status', v_existing.status, 'lineCount', v_existing.line_count, 'createdAt', v_existing.created_at);
  end if;
  for v_it in select value from jsonb_array_elements(v_items) loop
    v_qty := (v_it ->> 'qty')::integer;
    select * into v_row from dpg_commerce.product_snapshot(array[(v_it ->> 'id')::integer]);
    if not found or not v_row.listed then v_bad := v_bad || (v_it ->> 'id')::integer;
    else
      v_n := v_n + 1;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('n', v_n, 'id', v_row.id, 'sku', v_row.sku, 'name', v_row.name, 'brand', v_row.brand, 'qty', v_qty,
        'reason', case when v_row.orderable then 'CUSTOMER_REQUEST' else v_row.reason end, 'selling', v_row.selling_vnd));
    end if;
  end loop;
  if cardinality(v_bad) > 0 then return jsonb_build_object('error', 'PRODUCT_UNAVAILABLE', 'productIds', to_jsonb(v_bad)); end if;
  loop
    v_code := dpg_commerce.new_code('BG'); v_try := v_try + 1;
    exit when not exists (select 1 from dpg_commerce.quotes where code = v_code) or v_try > 5;
  end loop;
  insert into dpg_commerce.quotes (code, customer_name, customer_phone, customer_email, note, line_count, idempotency_hash, request_hash)
    values (v_code, v_contact ->> 'name', v_contact ->> 'phone', v_contact ->> 'email', v_contact ->> 'note', v_n, v_idem_hash, v_req_hash) returning id into v_id;
  for v_l in select value from jsonb_array_elements(v_lines) loop
    insert into dpg_commerce.quote_lines (quote_id, line_no, product_id, sku, product_name, brand, quantity, reason, unit_selling_vnd)
      values (v_id, (v_l ->> 'n')::integer, (v_l ->> 'id')::integer, v_l ->> 'sku', v_l ->> 'name', v_l ->> 'brand', (v_l ->> 'qty')::integer, v_l ->> 'reason', nullif(v_l ->> 'selling', 'null')::bigint);
  end loop;
  insert into dpg_commerce.events (entity, entity_id, actor, action, to_status) values ('quote', v_id, 'guest', 'created', 'new');
  return jsonb_build_object('ok', true, 'kind', 'quote', 'code', v_code, 'status', 'new', 'lineCount', v_n, 'createdAt', now());
end $$;

reset role;
-- guests: EXECUTE on the three entry points only; no schema/table privilege, no other function
revoke all on all functions in schema dpg_commerce from public;
grant usage on schema dpg_commerce to dpg_commerce_intake;
grant execute on function dpg_commerce.cart_check(jsonb, text), dpg_commerce.order_submit(jsonb, text, text), dpg_commerce.quote_submit(jsonb, text, text) to dpg_commerce_intake;
-- staff (Admin API role): read everything, change status/notes (version-checked by the handler), append events; never delete, never touch lines
do $$ declare r text := current_setting('dpg.commerce_admin_role', true); begin
  execute format('grant usage on schema dpg_commerce to %I', r);
  execute format('grant select on dpg_commerce.orders, dpg_commerce.order_lines, dpg_commerce.quotes, dpg_commerce.quote_lines, dpg_commerce.events to %I', r);
  execute format('grant update (status, staff_note, version) on dpg_commerce.orders, dpg_commerce.quotes to %I', r);
  execute format('grant insert on dpg_commerce.events to %I', r);
  execute format('grant usage on sequence dpg_commerce.events_id_seq to %I', r);
end $$;
-- defence in depth: RLS on, owner + admin policies only (no other role can ever read these tables, even if a grant is added by mistake)
do $$ declare r text := current_setting('dpg.commerce_admin_role', true); t text; begin
  foreach t in array array['orders', 'order_lines', 'quotes', 'quote_lines', 'events', 'rate_buckets'] loop
    execute format('alter table dpg_commerce.%I enable row level security', t);
    execute format('create policy owner_all on dpg_commerce.%I to dpg_commerce_owner using (true) with check (true)', t);
    if t <> 'rate_buckets' then
      execute format('create policy admin_select on dpg_commerce.%I for select to %I using (true)', t, r);
    end if;
  end loop;
  execute format('create policy admin_update on dpg_commerce.orders for update to %I using (true) with check (true)', r);
  execute format('create policy admin_update on dpg_commerce.quotes for update to %I using (true) with check (true)', r);
  execute format('create policy admin_insert on dpg_commerce.events for insert to %I with check (actor like %L)', r, 'admin:%');
end $$;
revoke dpg_commerce_owner from current_user;
commit;
