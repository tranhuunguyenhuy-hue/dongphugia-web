# 008 hosted apply on TEST (#446) — executed 23/11/2026

The function is owned by `dpg_order_intake_function_owner` (no login). The migration role (`postgres`) is already a member with
`inherit=false, set=false` (grantor `supabase_admin`, admin option). Owner-approved temporary procedure, ONE transaction:

1. guard: target contract `preview_synthetic`, 007 grants present, `dpg_app.orders` empty, owner has no CREATE on `public`.
2. `GRANT dpg_order_intake_function_owner TO postgres WITH SET TRUE;` `GRANT CREATE ON SCHEMA public TO <owner>;`
3. `SET LOCAL ROLE <owner>;` `CREATE OR REPLACE FUNCTION public.guest_order_request_create ...` (body = `008_hita_canonical_order_voucher.sql`)
4. `RESET ROLE; REVOKE CREATE ON SCHEMA public FROM <owner>; REVOKE SET OPTION FOR <owner> FROM postgres;` + in-transaction assertions.
5. **Lesson:** step 2 inserts a SECOND `pg_auth_members` row (grantor `postgres`), so `REVOKE SET OPTION` leaves `inherit=true`.
   Always finish with `REVOKE <owner> FROM postgres GRANTED BY postgres;` and read back: exactly one row remains
   (grantor `supabase_admin`, admin_option true, inherit false, set false).

Rollback: apply `008_hita_canonical_order_voucher_rollback.sql` with the same wrapper (it restores the captured original definition,
md5 of original `pg_get_functiondef` = `54ec73a4301a84aa0132a87cfe728504`; new = `480649393a209046a804fba86b6e620f`).
