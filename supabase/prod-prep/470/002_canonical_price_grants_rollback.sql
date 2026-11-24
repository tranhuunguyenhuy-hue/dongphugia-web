-- #470 DRAFT — rollback of 002 (columns had no ACL before, so revoke restores the previous state exactly).
begin;
set local lock_timeout = '5s';
select set_config('dpg.price_release_go', :'approved_sha', true);
do $$ begin if coalesce(current_setting('dpg.price_release_go', true), '') = '' then raise exception 'PRICE_RELEASE_NO_OWNER_GO'; end if; end $$;
revoke select (regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd, canonical_price_status) on dpg_app.products from dpg_public_catalogue;
revoke select, insert, update (regular_price_vnd, promotional_price_vnd, online_voucher_amount_vnd, canonical_price_status, canonical_price_checked_at) on dpg_app.products from dpg_admin_api;
commit;
