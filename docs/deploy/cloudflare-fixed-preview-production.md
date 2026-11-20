# Fixed Preview and Production release

Authority: [AGENTS.md](../../AGENTS.md), [Master #306](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/306), and the assigned GitHub issue. M2 Preview is accepted; no new Preview or Worker. V1 account `d54f3402b9d112ab64d6135e0e3f1fb1`; named Preview `staging` INSIDE `dongphugia-v1-public-production`; Production https://www.dongphugia.vn.

## Local and M3
- Node 24.13.0/npm 11.6.2, committed lockfiles; use targeted source tests and `npm run build:m3-combined-worker`, `npm run assemble:m3-fixed-preview` after checking script arguments/target contract. Do not use the old separate Admin shell.
- Require separate TEST PostgreSQL (project `uybumsnyqpwcidjxmfsv`), verified compatible schema/role/seed and separate Hyperdrive config IDs for Public read-only and Admin minimal write. Preview config explicitly binds TEST, never Production. M3 must prove real Admin auth/session/CSRF/RBAC, isolated media, noindex, query redaction, access protection and read-back/freshness. No private Production data.
- Own Preview settings/secrets/cookies. Confirm exactly named Preview, existing Access protection and no active Production release. Keep the accepted M2 artifact recoverable ([runbook](m2-fixed-preview-runbook.md)).
- Use reviewed combined artifact and exact source/target. Command form `wrangler preview --worker-name dongphugia-v1-public-production --name staging` with the verified artifact config, not root Next.js or `wrangler deploy`. M2 `v1-fixed-preview.yml` remains snapshot-only and does not prove M3 readiness; complete the M3 publisher/CI under Issue #309. Verify hosted CPU/runtime and actual login/CRUD/freshness/Public regression, report IDs and Owner UAT. Do not publish until TEST/Access/media gates pass.

## M4 and rollback
After accepted M3 and explicit M4 GO, verify backup/restore, exact Production target, separate Production-only Hyperdrive/roles/secrets, reviewed source/publisher. Use approved `.github/workflows/v1-worker-release.yml` (M4 must include accepted combined Admin artifact, not just Public). Validate real Production Public and Admin login/bounded reversible write/freshness. Preview rollback restores only prior accepted staging artifact. Production deployment rollback restores only code; database mutations need separate recovery. Never roll back Production during M3.

References: [Workers Previews](https://developers.cloudflare.com/workers/previews/), [Preview config](https://developers.cloudflare.com/workers/previews/configuration/), [Preview resources](https://developers.cloudflare.com/workers/previews/resources/). Verify current provider behavior before mutations.
