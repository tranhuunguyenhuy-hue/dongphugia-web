# M4 plan: promote the accepted Admin to Production (prepared, NOT executed)

Status: prepared in parallel with the M3 final gate (#309 / 7004192339). Nothing here changes Production. The Production target
contract flag `production_writes_allowed` stays `false`, no Production admin exists, no Production deployment happens, and no
data is touched until (1) M3 technical PASS is recorded and (2) the M4 prerequisites below are satisfied.

## 1. Facts verified read-only against Production (`bonxyxluzlxfkdetryoo`, 19/11/2026)
| Item | Value |
|---|---|
| `dpg_control.target_contract.production_writes_allowed` | `false` |
| `dpg_app.admin_users` | 0 rows (no Production admin yet) |
| Roles `dpg_admin_api`, `dpg_admin_api_test` | not present |
| Rows to preserve | products 17,752; brands 65; categories 5; orders 0; customers 0 |
| `products.version` | missing (migration `001` adds it additively, default 1) |
| `audit_logs.request_id / changed_fields` | missing (the API stores that metadata in `new_value._meta`) |

## 2. Migration package matches the accepted scope
- `supabase/m4-production/001_*` creates the Admin API role, support tables and `products.version`; `002_*` is generated from the same
  resource definitions as TEST and is drift-tested. After the scope decision it was regenerated: the eight Dev-managed master tables
  (categories, subcategories, brands, catalog taxons, product types/sub-types, spec definitions/options) get **SELECT only**, no
  sequence privileges, no `banner_url`; per-product tables keep their grants. A test (`production-migration.test.ts`) fails if a
  write grant on those tables ever reappears.
- Production never needs the TEST-only revoke `006`: a fresh Production role starts without those writes.
- Guards: both files refuse to run unless the target is the Production project and the Owner has set the contract flag
  (`M4_TARGET_GUARD_FAILED:production_writes_not_authorised`). Both have a rollback; `products.version` is kept on rollback.
- Applied to a Production-shaped local database including rollback and re-apply (integration test, 8 tests).

## 3. Code that still has to be written for the Production Worker (M4 build work, starts after M3 PASS)
The staging combined Worker is intentionally staging-only. For Production the release artifact must change as follows (exact list):
1. **Dispatch**: a Production variant of `apps/public/m3-combined-dispatch.mjs` (hosts `www.dongphugia.vn` and `dongphugia.vn`,
   `APP_ENV=production`, no `PREVIEW_NOINDEX` requirement) that serves `/admin-next/*` (SPA + gateway), redirects `/admin` and
   `/admin/*` to `/admin-next/` (302, same as staging) and never dispatches the legacy Admin UI.
2. **Gateway**: the approved function URL is a TEST-only constant (`m3-admin-gateway.mjs`); it must be parameterised to the
   Production function URL, with the Production origin (`https://www.dongphugia.vn`) as the verified same-origin marker.
3. **Upload path**: today `/api/upload-image` is the legacy Next route (session lookup through Prisma/Hyperdrive). Production must not
   depend on it. Plan: a small Worker handler `POST /admin-next/api/upload` that validates the session by a signed call to the
   function (`/me`), then runs the unchanged media processing (Images binding) and Bunny upload against the Production media
   zone with a Production-only key. Until then there is no safe upload in Production.
4. **Release workflow** _(historical plan; implemented as `.github/workflows/m4-production-admin-release.yml`, Production Release; the Public-only lane below is archived #510)_: adapt `.github/workflows/v1-worker-release.yml` (currently Public-only, `publish=false` verifies, `true`
   deploys) to build the combined Production artifact once and add the new Admin checks to its smoke (`/admin-next/` shell,
   unauthenticated `GET /admin-next/api/me` = 401, `/admin/*` redirects, master-data routes = 403, Public unchanged).
5. **Function deploy for Production**: a Production counterpart of `m3-admin-api-deploy.yml` (project `bonxyxluzlxfkdetryoo`,
   `ADMIN_API_DB_ROLE=dpg_admin_api`, `ADMIN_API_ALLOWED_ORIGIN=https://www.dongphugia.vn`, Production media host), guarded the same way.

## 4. Order of operations (each step verified before the next)
0. Preconditions: M3 PASS recorded; Owner confirms the M2 recovery artifact and the prerequisites in section 5.
1. Backup _(historical; current lane: `m4-production-backup.yml`, `runtime-backup.yml` archived #510)_: dispatch `runtime-backup.yml`; verify checksums and a restore into a scratch database; record the artifact ids.
2. Owner sets `dpg_control.target_contract.production_writes_allowed = true` (nothing else in the contract).
3. Apply `001`, verify, apply `002`, verify (read-only checks: grants, row counts unchanged, `products.version` backfilled).
4. Deploy the Production function; unsigned `GET /me` must answer 401 `INVALID_SIGNATURE`.
5. Owner creates the first Production admin (hash only, see below).
6. Publish the combined Production Worker (version recorded); run the Production smoke and a bounded real journey as the Owner admin.
7. Watch Production Public (cache, 5xx/1102) for the agreed window; then record M4 evidence and ask for acceptance.

## 5. Rollback
- Worker: redeploy the recorded previous Production version (current Public rollback target: `edcb15b2` / `5577b78d`, to be
  re-confirmed immediately before step 6). Worker rollback does not undo SQL.
- Function: `supabase functions delete admin-api --project-ref bonxyxluzlxfkdetryoo`.
- SQL: `002_..._rollback.sql` then `001_..._rollback.sql` (keeps `products.version`); restore from the step 1 backup only for data loss.
- Set the contract flag back to `false` after rollback.

## 6. Minimal Owner actions (only these, in this order, none before M3 PASS)
1. Keep a durable copy of the M2 recovery artifact `14253475719` (expiry reported 23 Nov 2026) or confirm one already exists.
2. Create a Supabase access token limited to project `bonxyxluzlxfkdetryoo` (Edge Functions + Secrets write) as the secret of a
   new GitHub environment (`m4-production-functions`), and a fresh `ADMIN_API_HMAC_SECRET` (32 random bytes, hex) for Production.
3. Provide the Production Bunny media key and CDN host as Worker secrets of the Production Worker.
4. At M4 start: set `production_writes_allowed = true`.
5. Create the first admin: generate a bcrypt (cost 12) hash locally and insert only the hash for the chosen email.
