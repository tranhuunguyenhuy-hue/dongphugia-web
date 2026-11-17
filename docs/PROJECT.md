# Đông Phú Gia V1 — technical handbook

[AGENTS.md](../AGENTS.md) is the shared policy; [Master #306](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/306) and the active issue contain Owner/Tech Lead decisions. [Current checkpoint](ops/project-current-state.md) holds mutable state. Keep scope small; open only the relevant references below.

## Delivery and acceptance

| Gate | Outcome | Issue |
| --- | --- | --- |
| M1 | Production Public serves PostgreSQL Products and Blog, verified visible routes and snapshot fallback | [#307](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/307) |
| M2 | ONE fixed named Preview `staging`, Public parity, rollback artifact | [#308](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/308) |
| M3 | All legacy Admin on that Preview, real Auth/RBAC/CRUD; distinct TEST DB and Admin-to-Public freshness | [#309](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/309) |
| M4 | Owner-accepted Admin at Production `/admin`, backed up and verified | [#310](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/310) |
| M5 | Audit routes/UI/mobile, SEO, product/price/media/Blog, auth/RLS, backups, CPU/performance, monitoring and cost; prioritized fixes/backlog | [#311](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/311) |

Products+Blog only is not full Admin. Restore actual existing modules, not new features. For M3/M4 verify dashboard, auth/session/CSRF/roles, products/SKU, Blog/tags, categories, banners/content, PIM brands/types/specs, customers, orders, quote requests, partners, projects and users as applicable to the source inventory. Do not expose private data to Public or fabricate features. Login, authorization denials, writes, independent read-back and Public refresh require real hosted proof. Owner UAT gates M4; M5 follows M4.

## Architecture and data

- Cloudflare account `d54f3402b9d112ab64d6135e0e3f1fb1`, Worker `dongphugia-v1-public-production`. Production domain https://www.dongphugia.vn; named staging Preview https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev (Access-protected). Separate deployments/settings; never publish a new Worker.
- Supabase Free organization Đông Phú Gia Runtime, Singapore: Production `dongphugia-production` ref `bonxyxluzlxfkdetryoo`; TEST `dongphugia-staging` ref `uybumsnyqpwcidjxmfsv`. Production uses `dpg_app`; do not assume same TEST schema cleared for writes. Separate roles, Hyperdrive and secrets. Old internal target-contract labels are not provider identity; never alter them just to rename a project. Preserve migration ledger and reviewed checksums.
- Public runtime `apps/public/worker.ts`, canonical UI `src/app/(public)/`, `src/components/`; Admin `src/app/admin/`; combined M3 build `npm run build:m3-combined-worker`. Existing `apps/admin/` is not a release target. Keep Public query bounding/cache, genuine PostgreSQL reads and snapshot rollback. Staging M2 snapshot is acceptable only for M2 or M2 recovery; M3 must prove dynamic same-TEST-data freshness.
- Data identity and provenance are authoritative. Keep product model/SKU, canonical path, status, category/relationships, verified price provenance, Blog dates/body/media. Do not infer missing attributes, price or stock. Keep Bunny bytes and DB media metadata distinct; do not overwrite Production media during TEST.
- Back up exact targets with a validated restore/reverse plan before live changes. Release code rollback does not undo SQL. Incremental infrastructure cost $0. No new paid resources.

## References — read only as needed

- [Fixed Preview and release](deploy/cloudflare-fixed-preview-production.md); [M2 accepted rollback](deploy/m2-fixed-preview-runbook.md); [CI/CD](ops/v1-fast-release.md).
- [Production read path and reconciliation](deploy/postgresql-production-adoption-contract.md); [database security](deploy/supabase-runtime-security-boundary.md).
- [Encrypted backup/restore](deploy/runtime-backup-recovery.md); [recovered database backup candidate](deploy/existing-state-backup.md); [backup bootstrap constraints](deploy/supabase-backup-role-bootstrap.md).
- [Product/Family preservation](deploy/product-family-preservation-contract.md); [Product pricing](adr/0020-v1-product-pricing-contract.md); [canonical Public UI](adr/0023-preserve-canonical-public-ui-through-cloudflare-runtime-adapters.md); [historical price display](adr/0024-restore-historical-public-prices-on-cloudflare.md).
- [Existing publishing API source reference](integrations/README.md) is for regression/audit only, not a work order.

Historical procedure documents are removed from the active tree; earlier revisions and issues remain in Git history for recovery. SQL, executable safety/backup controls, fixtures and proof manifests remain untouched unless the assigned milestone needs a reviewed change.
