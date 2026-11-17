# Đông Phú Gia V1 — technical handbook (CURRENT)

Effective: **2026-11-17**, supersedes former V1 roadmap/Phase 2 and dated AWS/Preview handoffs. **For execution authority read root `AGENTS.md` and the current milestone Issue.**

## Goal and hard milestone sequence

| Gate | Owner outcome | Issue | Validation |
| --- | --- | --- | --- |
| **M1 DONE / OWNER-ACCEPTED** | Production Public uses V1 PostgreSQL; recovered Products/SKUs and Blog accepted | [#307](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/307) | Owner UAT acceptance recorded in the issue |
| **M2 DONE / OWNER-ACCEPTED** | Fixed Preview named `staging` inside `dongphugia-v1-public-production` passed Gate B | [#308](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/308) | Public parity and Gate B acceptance recorded in the issue |
| **M3 ACTIVE** | Full legacy Admin on the same fixed Preview with real Hyperdrive/Auth/session/RBAC and separate TEST DB | [#309](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/309) | Module coverage, Preview login/CRUD, isolation and hosted runtime evidence |
| M4 QUEUED | Deploy accepted Admin to same-origin Production `/admin` | [#310](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/310) | Owner acceptance, backup, Production login/CRUD/fresh Public, rollback |
| M5 QUEUED | Audit website and propose future backlog | [#311](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/311) | Issue-level findings with URLs, priority, estimates; no automatic feature work |

Master tracker: [#306](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/306). Milestones are sequential; M1 and M2 are Owner-accepted and M3 is active.

## Live environment architecture and provenance

- Cloudflare V1 account: `d54f3402b9d112ab64d6135e0e3f1fb1` (revalidate before modifying).
- Supabase Production: `dongphugia-production`, ref `bonxyxluzlxfkdetryoo`, region `ap-southeast-1`, verified `ACTIVE_HEALTHY` on 2026-11-17.
- Supabase Staging/TEST: `dongphugia-staging`, ref `uybumsnyqpwcidjxmfsv`, region `ap-southeast-1`, verified `ACTIVE_HEALTHY` on 2026-11-17. This identity change does not establish M3 schema, role, data isolation, or consumer readiness; confirm those independently before any hosted write.
- Production Worker: `dongphugia-v1-public-production`, custom domains `www.dongphugia.vn`, `dongphugia.vn`. Production source SHA read back at M2 closure: `87a0e4b6cd9997be8e195ce2bd9a6647608ee253`; M1 was Owner-accepted. M3 must not alter Production.
- M2 fixed Worker Preview `staging` was accepted at Gate B inside the Production Worker: URL `https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev`, deployment `ab789db6-fc80-4c81-a884-fdcbe6e6bfcb`, source SHA `00914b73fe6eed8dd78a8e8d8884bfa475c60870`. This was Public parity evidence, not an M3 Admin deployment. The separate `dpg-staging` Worker is obsolete and must not be used or deleted.
- M3 uses isolated Staging/TEST Supabase ref `uybumsnyqpwcidjxmfsv` only after schema, roles, data isolation, Hyperdrive and consumers are verified. A project rename or `ACTIVE_HEALTHY` status does not establish this readiness. Preview settings/secrets remain separate from Production.
- Production application schema is `dpg_app`; confirm hosted schema, rows and permissions before any write. Never confuse either V1 project with V2.
- PR #300: legacy Products/Blog Admin source recovered locally. PR #301: local Workerd/Prisma test only. PR #304: proposed least-privilege DB role tested locally. **None constitutes hosted Admin or Production database import proof.** Reported 17,752 Products and 10 Blogs are local recovery evidence until independently reconciled on hosted DB.

## M1 — Production database recovery contract

1. Inventory source and destination: source of truth, 27-table historical backup/other supported recovery assets, products vs SKU semantics, public status, unique keys, category, slug, price source, media, Blog posts/slugs/body/images. Determine actual definitive counts from verified source; do not hardcode 17,752/10 as success threshold.
2. Verify hosted V1 database target and safety: fresh backup and testable restore point, migration parity, read-only reporting, free-tier size/CPU/cost limits. No blind destructive restore, overwrite or schema changes.
3. Import or reconcile missing source content idempotently with duplicate-safe keys; report totals, published totals, exact-SKU coverage, image references, Blog status and broken routes, unresolved discrepancies.
4. Add a **read-only** Worker-to-PostgreSQL adapter (Hyperdrive if measured compatible), scoped credentials/secret, finite query pagination, caching/freshness, graceful handling of DB unavailability. Keep canonical Public UI. No service credentials in browser.
5. Prove **actual** Production Public read path uses hosted PostgreSQL, not just a DB population. Validate sampled category/PLP/PDP/search and all published Blog routes. Keep snapshot as pretested fallback; document Worker rollback and DB restoration separately.
6. No price, stock, family or Blog publication assertions without evidence. If price unverified show `Liên hệ báo giá`; historical reference price needs clear provenance label.

M1 is complete **only when hosted DB is reconciled AND Production Public visibly serves it.**

## M2 — ONE fixed Worker Preview `staging`

Create/update a single Worker Preview named `staging` under existing `dongphugia-v1-public-production` (using `npx wrangler preview --worker-name dongphugia-v1-public-production --name staging`, after verifying repository configuration). This is **not a new Worker**. Match current Production Public visuals and behavior, including HeroBanner, categories, SKU search, PDP and Blog. Published read-only snapshot is allowed here. Record exact Preview URL/deployment ID, responsive parity and revert path. Do not create additional PR Previews. Preview needs its own explicit settings, secrets and resources for M3; see `docs/deploy/cloudflare-fixed-preview-production.md`.

## M3 — legacy Admin source and end-to-end functional scope

Target the canonical old `src/app/admin` and associated server modules, not a new `apps/admin` design. First compare original Admin route inventory to restored code: dashboard, auth and account lifecycle, Products/SKUs, Blog and other existing modules. Explicitly list present, missing, disabled and unsupported functions; **Products+Blog only is not “full Admin.”** Restore missing legacy functions within actual historic scope; do not invent new commerce features.

Hosted fixed Worker Preview compatibility test must establish real login/session, permission denials, streamed SSR, Prisma/connection pooling, Cloudflare CPU budget, Product/Blog writes, audit and reload persistence using an isolated test PostgreSQL DB. Owner expressly authorizes the full old Admin, Hyperdrive, Auth and other essential functionality on this one Preview; protect its URL with Access/equivalent plus real app login, isolate cookies/secrets/DB and test actual hosted CPU/runtime. Build/test locally first, promote to the fixed Preview for real integration. Do not unlock private pages by disabling Auth, do not share privileged DB access with Public and do not rely on a login-shell HTTP 200.

## M4 — Production promotion

After M1–M3/Owner acceptance: use reviewed artifact/code, same-origin `/admin`, V1 Production credentials with least privileges and recovery/backup. Validate Production read + bounded reversible write, actual Public refresh/invalidation and complete logged-in Admin smoke. Roll back Worker version as needed; SQL changes require their own restore/reverse plan. Never interpret successful upload as successful running Admin.

## M5 and exclusions

Only post-recovery audit for broken images/routes, product data, Blog media, SEO, design parity, CPU and performance, auth and backup correctness. Defer all elective features until new approval. Explicitly canceled: Phase 2 cart/order/checkout, new Admin platform and independent Admin domain, variant research/crawler, multi-agent parallel orchestration, per-branch PR previews, using obsolete separate `dpg-staging` Worker, old AWS/EC2/Coolify staging, speculative infrastructure and separate approvals to prepare each local test.

## Source structure and data rules

- Canonical prior UI in `src/app/(public)/`, `src/components/`; deployed Public runtime `apps/public/` is adapted to Worker. Avoid unrelated UI rewrites.
- Legacy Admin in `src/app/admin/`; new `apps/admin/` is archival/experimental, not M3/M4 target.
- Database source in `prisma/`, `db/`, `supabase/`; code/SQL migrations must not be auto-applied just because checked in.
- Product identity, SKU, category, status, prices, slug, canonical path and Blog publication are first-class; manufacturer/document provenance is evidence, not licence to infer current price.
- External media remains Bunny-compatible; verify image bytes, not merely stored URL.
- Preserve rollback SQL/sha256, backups, imports, provenance and required CI even when deleting old **policy** documentation; these remain technical assets, not active work tickets.

See `docs/deploy/cloudflare-fixed-preview-production.md` and `docs/deploy/postgresql-production-adoption-contract.md`. Snapshot evidence is kept in `docs/ops/project-current-state.md`, but **live provider verification overrides date-stamped observations**.

### Supabase naming compatibility

Historical records may retain former display labels. The `dongphugia-runtime` string also remains intentionally unchanged as the internal `dpg_control.target_contract.project_name` compatibility key in database contracts and their tests; it is not a provider project name or a reason to select a different ref. Use the canonical names and immutable refs above for current provider identity.


## Legacy data-security evidence retained for audit only

The historical LEO-539 synthetic Supabase security proof is located at `docs/deploy/supabase-runtime-security-boundary.md` and project `tlmgudfhsyzayiazuugf`. It is **not** the current V1 Production database, **not** authorized for data import or Admin testing, and does not supersede #307. Keep its source SQL/security tests intact as provenance, but do not initiate its discontinued delivery track.
