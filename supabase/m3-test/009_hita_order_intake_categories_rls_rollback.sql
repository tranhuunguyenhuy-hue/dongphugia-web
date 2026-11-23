-- #446: exact reverse of 009 (there was no policy for this role before). Policy only; data and grants untouched.
begin;
set local lock_timeout = '5s';

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

drop policy if exists phase2_guest_categories_select_sanitary on dpg_app.categories;

commit;
