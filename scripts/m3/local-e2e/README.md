# Local end-to-end harness for the Admin (`/admin-next`)

Runs the real SPA + gateway + Deno `admin-api` against a Production-shaped local PostgreSQL and drives Chromium (desktop + mobile).
Nothing here touches Supabase, Cloudflare or any hosted database. Requirements: PostgreSQL superuser at
`postgres://postgres:postgres@127.0.0.1:5432` (edit the URLs in `setup-db.cjs`/`ui.cjs` if different), Deno, Playwright Chromium.

```bash
node scripts/m3/local-e2e/setup-db.cjs                                    # database dpg_e2e: fixtures + 004 + 005 + seed users
# in apps/admin-spa: ../public/node_modules/.bin/vite build              # builds the SPA into apps/admin-spa/dist
cd supabase/functions/admin-api && ADMIN_API_DB_URL=postgres://dpg_admin_api_test:e2e-api-pass@127.0.0.1:5432/dpg_e2e \
  ADMIN_API_HMAC_SECRET=local-secret-abcdef-0123456789-long-enough ADMIN_API_ALLOWED_ORIGIN=http://localhost:8800 \
  ADMIN_API_MEDIA_HOSTS=dpg-media-staging.b-cdn.net DENO_SERVE_ADDRESS=tcp:127.0.0.1:8799 \
  deno run --config deno.json --allow-net --allow-env --allow-read index.ts &
node scripts/m3/local-e2e/stack.mjs &                                     # gateway + static SPA on http://localhost:8800
node scripts/m3/local-e2e/ui.cjs                                          # 18 browser checks, exits non-zero on failure
```
Seed accounts (local only): admin@example.test / admin-pass-1, manager@example.test / manager-pass-1, sale@example.test / sale-pass-1.
