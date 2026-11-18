# M3 G4 pilot: static Admin shell + `admin-api` Edge Function (TEST only)

Scope: Owner/TL directive #360 comment 6977090843 (G4). Same named staging, no new Worker/preview/paid resource.
Production Admin, Production DB and Production credentials are out of scope and rejected by guards.

## Request flow
Browser → `https://staging-…workers.dev/admin-next/` (static assets, free) → `/admin-next/api/*` (Worker gateway,
`apps/public/m3-admin-gateway.mjs`: route allow-list, same-origin check, HMAC signing, HttpOnly SameSite=Strict
`dpg-admin-session` cookie) → Supabase Edge Function `admin-api` on **uybumsnyqpwcidjxmfsv** → PostgreSQL as
`SET LOCAL ROLE dpg_admin_api_test` (column grants + RLS, `supabase/m3-test/004`). Upload uses the unchanged legacy
`/api/upload-image` (Cloudflare Images transform + isolated Bunny target); the new login creates a normal
`admin_sessions` row so the legacy route and legacy Admin accept the same session.

## Security properties (all covered by tests in `supabase/functions/admin-api/admin-api.test.ts` and `apps/public/m3-admin-gateway.test.mjs`)
- HMAC-SHA256 envelope over route, body hash, client IP, verified origin and session hash; ±60 s skew; atomic nonce
  replay protection in the DB; mutations require the gateway-verified origin marker.
- bcrypt cost 12 unchanged; constant-ish login timing for unknown users; persistent rate limit (5 failures/15 min per
  account, 20 per IP); session token stored as SHA-256 only; logout deletes the row; expired/deactivated users rejected.
- RBAC (`permissions.ts` is byte-identical to `src/lib/auth/permissions.ts`, enforced by a test) on every operation;
  visibility fields additionally require `visibility:write`.
- Parameterised SQL, zod validation, optimistic versioning, audit row in the same transaction, price/identity columns
  not grantable to the role, no service-role key, `verify_jwt=false` justified by the HMAC envelope.

## Owner actions (the only manual steps)
1. **Apply the migration** (the Supabase MCP asks for an interactive confirmation that is not shown in this session):
   Supabase dashboard → project `dongphugia-staging` (ref `uybumsnyqpwcidjxmfsv`, TEST) → SQL Editor → run
   `supabase/m3-test/004_m3_test_admin_api.sql` (contains its own TEST target guard). Rollback: `…_rollback.sql`.
2. **Create the shared secret**: `openssl rand -hex 32` → GitHub repository secret `M3_ADMIN_API_HMAC_SECRET`.
3. **Deploy the function + set its secrets**, either
   a. create GitHub environment `m3-test-functions` with secret `SUPABASE_TEST_ACCESS_TOKEN` (a Supabase token limited
      to the TEST project: Edge Functions write, Secrets write) and dispatch `m3-admin-api-deploy.yml` on main; or
   b. run `M3_ADMIN_API_HMAC_SECRET=<same value> ./scripts/m3/deploy-admin-api-test.sh` after `supabase login`.
4. Re-run the staging publish (`v1-fixed-preview.yml`, `publish-m3`) so the Worker receives the secret.
Until step 2 is done the publisher uses a random secret, so the shell loads but the gateway is rejected by `admin-api`.

## Rollback
Worker: previous staging deployment (artifact preserved); function: `supabase functions delete admin-api`
(TEST only); database: `004_m3_test_admin_api_rollback.sql`. Legacy `/admin` is untouched and remains available.
