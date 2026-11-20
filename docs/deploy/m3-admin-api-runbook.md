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
(TEST only); database: `004_m3_test_admin_api_rollback.sql`. (Superseded by the scope decision below: the legacy `/admin` UI is retired on staging; its source and artifacts are kept in the repository.)

---

# Update — full module port (M3 batch 2, #360 delegation 6988598277)

## What exists in `/admin-next` now
One declarative definition per resource (`supabase/functions/admin-api/resources.ts`) drives validation, parameterised SQL,
RBAC, audit, the form metadata served at `/schema`, and the generated column-level grants (`grants.ts` →
`supabase/m3-test/005_*.sql`, drift-checked by a test). Dedicated handlers cover orders, quotes, dashboard (`commerce-handlers.ts`).

| Legacy area | New screens / endpoints | Notes |
|---|---|---|
| Dashboard | `/dashboard` | KPIs, revenue by period, pending quotes/orders, top products. Revenue counts `completed` **and** `delivered` (legacy filtered on `delivered`, which no workflow produces) |
| Products | `/r/products`, gallery, bulk toggle/feature/delete | `sku`/`slug` create-only (identity), `sale_price < list_price`, activation needs price (or "contact") + main image, optimistic `version` |
| Categories | `/r/categories` | banner only (the only legacy write); subcategories read-only |
| PIM | brands, taxons, product types/sub-types, spec definitions/options | no hard delete (legacy toggles `is_active`); spec options are create-only as in legacy |
| Orders | `/orders`, `/orders/:id` | status, payment, assignment, builder with server-recomputed totals, A4 print; sales see/act on assigned orders only |
| Quote requests | `/quotes`, `/quotes/:id` | status, assignment, builder, complete = customer found/created by phone (CSKH); A4 print |
| Customers | `/r/customers` | create/edit, unique phone |
| Blog | posts (TipTap editor, tags, publish rules, Publishing-Agent guard), tags | tag counters maintained transactionally |
| Banners / Đối tác / Dự án | `/r/banners`, `/r/partners`, `/r/projects` | partner/project slug generated once (legacy behaviour) |
| Users | `/r/users` | bcrypt cost 12 server-side, sessions revoked on password change/deactivation, last active admin protected |

Product editor also covers: gallery, documents (https only), spec values, taxon assignments, relations (combo components) as child records, and variant link/unlink (legacy `variant_group` semantics).

Not ported (explicit gaps, tracked for M5): the legacy "quick create product" modal and drag-reorder of the product list (sort order is editable per product); order creation (legacy has no UI for it); the PIM "pilot" screens.

## Owner action for hosted verification (TEST)
Run **`supabase/m3-test/005_m3_test_admin_resources.sql`** in the SQL Editor of `dongphugia-staging` (ref `uybumsnyqpwcidjxmfsv`;
it carries the TEST target guard and is idempotent). Rollback: `005_…_rollback.sql`. Then (Claude can do these) dispatch
`m3-admin-api-deploy.yml`, publish staging with `v1-fixed-preview.yml publish-m3`, and run the hosted acceptance.

## Local end-to-end harness
`scripts/m3/local-e2e/` rebuilds a Production-shaped PostgreSQL database (fixtures + 004 + 005), runs the Deno function and the
real gateway with the built SPA, and drives Chromium (desktop + mobile) through every module. Run it with the commands in its README.

## Driver parity rules learned the hard way
postgres.js (Edge) ≠ node-pg (tests): bind JSON as `$n::text::jsonb` (postgres.js would double-encode a string bound to a jsonb
parameter), never `select *` from a column-granted table, and give every parameter used in two typed contexts an explicit cast.

# M4 package (Production Admin) — prepared, NOT executed

The complete, current M4 plan (verified facts, code still to write, order, rollback, minimal Owner actions) is [m4-production-admin-plan.md](m4-production-admin-plan.md).

Preconditions that only the Owner can satisfy (none are done):
1. **Contract**: Production `dpg_control.target_contract.production_writes_allowed` is `false` today (read-only check). The M4
   migration refuses to run until the Owner sets it to `true` (`M4_TARGET_GUARD_FAILED:production_writes_not_authorised`).
2. **Backup** verified (existing `runtime-backup.yml` workflow) immediately before the migration.
3. **Schema drift fixed by the migration** (verified read-only against Production): `products.version` is missing on Production
   (present on TEST) → `001` adds it additively; Production `audit_logs` has no `request_id/changed_fields` → the API writes the
   base columns and keeps that metadata in `new_value._meta`. Every other column the Admin queries use exists on Production.
4. **First admin account**: Production `admin_users` is empty. The Owner creates the first admin (password never enters chat/repo):
   hash locally with bcrypt cost 12 and insert only the hash.
5. **Edge Function on the Production project** `bonxyxluzlxfkdetryoo`: a Supabase access token limited to that project
   (Edge Functions + Secrets write) stored as a GitHub environment secret, plus function secrets `ADMIN_API_HMAC_SECRET`,
   `ADMIN_API_ALLOWED_ORIGIN=https://www.dongphugia.vn`, `ADMIN_API_MEDIA_HOSTS=<production CDN host>`, `ADMIN_API_DB_ROLE=dpg_admin_api`.
6. **Worker**: the Production artifact must add the gateway, the SPA assets, an `/admin` → `/admin-next/` redirect and an upload path that
   does not depend on legacy Prisma code; `ADMIN_API_HMAC_SECRET` as a Worker secret and the Production approved function URL.

Prepared artifacts (generated, drift-tested, applied successfully to a Production-shaped database including rollback + re-apply):
`supabase/m4-production/001_m4_production_admin_api_base.sql`, `002_m4_production_admin_resources.sql` and their `_rollback.sql`.
Regenerate/check: `npx tsx scripts/m4/generate-production-admin-migration.mts [--check]`.
Rollback order: Worker (previous Production version `edcb15b2`/`5577b78d`), function delete, `002_rollback` then `001_rollback`
(`products.version` is kept), restore from backup only for data loss (Worker rollback ≠ SQL rollback).

## Admin scope: Dev-managed catalogue master data (Owner decision, #309, 19/11/2026)

The Admin manages **products and their per-product records**, orders, quotes, customers, blog, banners, partners, projects, users and the dashboard.
These shared definitions are **Dev-managed** and have **no Admin screen, route or write path for any role** (including `admin`):
categories/subcategories (and the category content banner), brands, catalog taxons, product types/sub-types, spec definitions/options, origins, colors, materials.

What changed (nothing is deleted; no table, row, ID, FK, seed or Public behaviour is touched):
- `resources.ts`: these eleven resources carry `lookup: true` (no write/create/delete, no nav, omitted from `/schema`). Only `GET /r/<key>/options` (id + label) is served, so the product editor and filters keep working.
- `resource-handlers.ts`: `assertManaged` makes list/get/create/update/delete answer `403 DEV_MANAGED` even if a route or definition were wrong. The gateway (`m3-admin-gateway.mjs`) refuses the same routes before contacting the function.
- Database: `supabase/m3-test/006_m3_test_admin_scope_revoke.sql` (+ `_rollback.sql`) is **revoke-only and guarded**: it removes the INSERT/UPDATE/DELETE privileges, sequence privileges and write RLS policies of `dpg_admin_api_test` on the eight writable master tables; SELECT stays. `005_*` and the M4 `002_*` were regenerated from the new definitions (they no longer grant those writes), so a fresh database and an already-granted TEST database end in the same state. Per-product child tables (`product_spec_values`, `product_taxon_assignments`, images, documents, relationships) keep their grants.
- The legacy Next Admin (`/admin/*`) is no longer dispatched by the combined Worker on staging: pages redirect to `/admin-next/`, other methods and framework assets return 404 (`/api/upload-image` and `/api/admin/revalidate` are unchanged). The legacy source and the reviewed M2/M3 artifacts stay in the repository for recovery; this is not a deletion.

How Dev changes master data (existing workflow, unchanged): versioned SQL under `prisma/migrations/` (e.g. `20260704150500_catalog_taxonomy_v2_schema`) applied through the guarded runner `scripts/db/postgres-migration-runner.ts` against an attested target; `prisma/seed.ts` / `seed-data.ts` are for development and TEST only. Production data is changed by a reviewed migration, never by re-running the seed.
