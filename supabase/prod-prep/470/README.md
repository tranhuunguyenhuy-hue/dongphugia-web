# #470 Production price preparation — DRAFT, NOT APPLIED

Everything here is **source only**. Nothing in this directory is under `supabase/migrations/` on purpose, so no
tooling applies it automatically. Applying any file to Production needs a separate Owner GO naming the exact SHA,
SQL and rollback (see `docs/ops/price-release-470/production-release-readiness.md`).

Reconciled with the live Production schema read-only on 2026-11-24 (ref `bonxyxluzlxfkdetryoo`, PG 17.11), **not**
copied from `supabase/m3-test/006–009`:

| Fact (live) | Consequence |
|---|---|
| `dpg_app.products` has no canonical columns and only one CHECK (`direct_parity_16`) | additive columns + one new CHECK |
| `dpg_control.target_contract` row is `environment='preview'`, `production_writes_allowed=true`, ceiling 367001600 | guard = "not `preview_synthetic`" **and** exact ceiling **and** an explicit approval GUC |
| `dpg_public_catalogue` has column-level SELECT only and cannot read any legacy price column | it gets SELECT on the new columns only (the single widening of the public read role) |
| `dpg_runtime`, `dpg_readonly`, `authenticated`, `dpg_m2_snapshot_read`, `dpg_backup_reader` have table-level SELECT | no grant needed (new columns are readable) |
| `dpg_admin_api` has per-column a/r/w and cannot update `price_state` | per-column grants on the new columns only |
| `dpg_migration` is NOLOGIN without BYPASSRLS; `postgres` (BYPASSRLS, inherits `dpg_migration`) is the operator; `dpg_direct_import` has no UPDATE | DDL/import run as `postgres`; no new write privilege for import |
| live order/quote functions are invoker functions that price from `list_price`/`sale_price` and know no voucher | `003` replaces them; baseline md5 is asserted before replacing |

| File | Purpose | Rollback |
|---|---|---|
| `001_canonical_price_columns.sql` | 3 canonical VND columns, `canonical_price_status`, `canonical_price_checked_at`, one CHECK | `001_…_rollback.sql` (refuses if any value is populated) |
| `002_canonical_price_grants.sql` | minimum column-level grants | `002_…_rollback.sql` |
| `003_runtime_order_quote_canonical.sql` | sanitary-only canonical branch in `runtime_order_create` / `runtime_quote_create` | `003_…_rollback.sql` (restores the live baseline text, md5-asserted) |
| `tests/run-local.sh` | proof on an **isolated local** PostgreSQL fixture shaped like Production | — |

Approval GUC (set per session by the operator after Owner GO, never in a file):
`select set_config('dpg.price_release_go', '<approved-sha>', false);` — each file refuses to run unless it is non-empty
and equals the value passed to `-v approved_sha`.

Status model (`canonical_price_status`, NULL = never crawled / unverified → price hidden, "cần liên hệ"):
`PRICE_VERIFIED` (regular price present), `CONTACT_VERIFIED` (Hita page really says "Liên hệ"), `UNRESOLVED`,
`NOT_FOUND`, `DISCONTINUED`. Prices exist **only** with `PRICE_VERIFIED`; the CHECK enforces it. Legacy `price_state`
is not reused or modified.

Local proof: `bash supabase/prod-prep/470/tests/run-local.sh <socket-dir> <port> <superuser>` (isolated PostgreSQL ≥ 15, never a hosted project). It installs the live baseline function text, asserts its md5 equals Production's, applies 001→003, asserts CHECK/ACL/behaviour, then rolls everything back and re-asserts the baseline.
