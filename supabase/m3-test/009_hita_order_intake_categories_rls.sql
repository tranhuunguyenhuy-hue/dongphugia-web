-- #446 (Claude, Backend/Infra lane): TEST ONLY. dpg_app.categories has FORCE ROW LEVEL SECURITY and no policy for the order-intake
-- function owner, so inside public.guest_order_request_create the owner sees ZERO categories, cannot recognise `thiet-bi-ve-sinh` and falls
-- back to the legacy price branch (found on Fixed Staging run 59: PRODUCT_REQUIRES_QUOTE for priced canonical SKUs). One narrow SELECT
-- policy for that role, limited to the single category the canonical branch needs. Previous state: no policy for this role (nothing to restore).
-- Idempotent. Rollback: 009_hita_order_intake_categories_rls_rollback.sql (drop policy).
begin;
set local lock_timeout = '5s';

-- guard:begin
do $$
begin
  if not exists (
    select 1 from dpg_control.target_contract
    where environment = 'preview_synthetic'
      and production_writes_allowed = false
      and production_data_allowed = false
      and production_credentials_allowed = false
  ) then
    raise exception 'HITA_CATEGORIES_RLS_TARGET_NOT_TEST';
  end if;
end
$$;
-- guard:end

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'dpg_order_intake_function_owner') then
    raise exception 'HITA_CATEGORIES_RLS_ROLE_MISSING';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'dpg_app' and tablename = 'categories'
             and policyname = 'phase2_guest_categories_select_sanitary'
             and roles::text <> '{dpg_order_intake_function_owner}') then
    raise exception 'HITA_CATEGORIES_RLS_POLICY_NAME_CONFLICT';
  end if;
end
$$;

drop policy if exists phase2_guest_categories_select_sanitary on dpg_app.categories;
create policy phase2_guest_categories_select_sanitary on dpg_app.categories
  for select to dpg_order_intake_function_owner
  using (slug = 'thiet-bi-ve-sinh');

commit;
