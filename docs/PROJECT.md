# Đông Phú Gia V1 — technical handbook

[AGENTS.md](../AGENTS.md) is the shared policy; [current checkpoint](ops/project-current-state.md) holds mutable state; your assigned issue holds the task. Keep scope small; open only the references you need.

## Architecture

- Cloudflare account `d54f3402b9d112ab64d6135e0e3f1fb1`, one Worker `dongphugia-v1-public-production`. Production https://www.dongphugia.vn; fixed Preview `staging` https://staging-dongphugia-v1-public-production.tranhuunguyenhuy.workers.dev (Access-protected). Never publish a second Worker.
- Source roots: Public runtime `apps/public/worker.ts`; canonical Public UI `src/app/(public)/` and `src/components/`; canonical Admin `src/app/admin/` with its SPA/gateway under `apps/admin-spa/`; database sources `prisma/`, `db/`, `supabase/` (do not apply blindly). `apps/admin/` is not a release target.
- Production artifact: combined Public+Admin Worker built by `npm run build:m3-combined-worker` and released only through `.github/workflows/m4-production-admin-release.yml` (see [CI/CD](ops/v1-fast-release.md)). Node 24.13.0, npm 11.6.2, locked dependencies.
- Supabase Free organization Đông Phú Gia Runtime (Singapore): Production `dongphugia-production` `bonxyxluzlxfkdetryoo` (schema `dpg_app`); TEST `dongphugia-staging` `uybumsnyqpwcidjxmfsv`. Separate roles, Hyperdrive and secrets. Do not assume a TEST schema is cleared for writes. Preserve the migration ledger and reviewed checksums.
- Bunny is the media provider (`dpg-products.b-cdn.net`); keep Bunny bytes and DB media metadata distinct.
- Data identity and provenance are authoritative: product model/SKU, canonical path, status, relationships, verified price provenance, Blog dates/body/media. Do not infer missing attributes, price or stock.
- Back up exact targets with a validated restore/reverse plan before live changes. Worker rollback does not undo SQL. Incremental infrastructure cost $0.

## Typical task path

Issue (from [template](../.github/ISSUE_TEMPLATE/agent-task.md)) → branch `codex/<issue>-<slug>` or `claude/<issue>-<slug>` → PR with evidence → `quality` CI → Tech Lead review → Owner acceptance → serialized Production release by the reviewed lane, only with Owner approval. Merge is not deploy; compare `main` with the deployed Worker version in the checkpoint.

## References — read only as needed

- Release and rollback: [CI/CD](ops/v1-fast-release.md); [M4 Admin plan](deploy/m4-production-admin-plan.md); [fixed Preview](deploy/cloudflare-fixed-preview-production.md); [M2 rollback](deploy/m2-fixed-preview-runbook.md); [M3 Preview runbook](deploy/m3-fixed-preview-runbook.md); [Admin API runbook](deploy/m3-admin-api-runbook.md).
- Database and backup: [Production read path](deploy/postgresql-production-adoption-contract.md); [database security](deploy/supabase-runtime-security-boundary.md); [backup/restore](deploy/runtime-backup-recovery.md); [backup recovery runbook](ops/m5-backup-recovery-runbook.md); [CDN normalization](ops/m5-legacy-cdn-normalization-plan.md).
- Product and UI contracts: [Product/Family preservation](deploy/product-family-preservation-contract.md); [pricing](adr/0020-v1-product-pricing-contract.md); [canonical Public UI](adr/0023-preserve-canonical-public-ui-through-cloudflare-runtime-adapters.md); [historical price display](adr/0024-restore-historical-public-prices-on-cloudflare.md).
- [Publishing API source reference](integrations/README.md): regression/audit only, not a work order.

## History — completed restoration (not gates for new work)

| Milestone | Outcome | Issue |
| --- | --- | --- |
| M1 | Production Public on PostgreSQL Products and Blog | [#307](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/307) |
| M2 | Fixed Preview `staging`, Public parity | [#308](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/308) |
| M3 | Legacy Admin on Preview with real Auth/RBAC/CRUD | [#309](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/309) |
| M4 | Accepted Admin promoted to Production | [#310](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/310) |
| M5 | Audit, backup gate, CDN normalization | [#311](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/311) |

Master [#306](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/306). Older procedure documents are in Git history. SQL, safety/backup controls, fixtures and proof manifests stay untouched unless the assigned issue requires a reviewed change.
