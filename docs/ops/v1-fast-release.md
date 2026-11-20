# V1 CI/CD fast lane

One branch and one PR per issue. Policy: [AGENTS.md](../../AGENTS.md); live state is verified in Cloudflare/GitHub Actions, not in a status file. No parallel deployment paths; Production deploys are serialized and need Owner approval.

1. **Verify** affected source with focused tests, typecheck/build and PR. Required GitHub status: `quality`; documentation-only changes skip expensive application checks, but code, test and workflow changes must pass the actual required checks.
2. **Release the combined Public+Admin Worker** only with `.github/workflows/m4-production-admin-release.yml` from reviewed `main`: run `operation=verify` first, then `publish` for the exact approved SHA, with `rollback_version_id` equal to the version active right now and `owner_ready_confirmed=true`. Supabase function changes use `.github/workflows/m4-production-function-deploy.yml`.
3. **Do not** use `v1-worker-release.yml` (refuses to publish while Production carries the Admin), the M2 `v1-fixed-preview.yml` snapshot lane (recovery/staging only), or any publish of a snapshot/Public-only artifact over the Admin. Do not change DNS or Production settings to make a check pass.
4. **Record** in the assigned issue: run, source SHA, artifact, deployment and version ID, effective DB/roles, real live smoke, PASS/FAIL/UNKNOWN and the rollback target. Worker rollback does not restore SQL.

## Production facts and rollback (verify live before relying on them)

- Worker `dongphugia-v1-public-production` serves canonical Public plus the accepted Admin under `/admin-next`; legacy `/admin*` redirects (302). Edge Function `admin-api` runs on Production `bonxyxluzlxfkdetryoo` (`production_writes_allowed = true`, migrations `001`/`002` applied). Public reads through Hyperdrive with the read-only role `dpg_public_catalogue`. Read the active deployment and version from Cloudflare (`/workers/scripts/dongphugia-v1-public-production/deployments`) before every release.
- Rollback order: Worker `wrangler rollback <previous version>` (does not undo SQL) → delete the function → revoke banner grant/policy → `002`/`001` rollbacks; restore from backup only for data loss. Detail: [M4 Admin plan](../deploy/m4-production-admin-plan.md).
- Backup: `.github/workflows/m4-production-backup.yml` daily 19:41 UTC with an encrypted restore rehearsal; see the [backup runbook](m5-backup-recovery-runbook.md). Media/CDN state and rollback ledgers: [CDN normalization](m5-legacy-cdn-normalization-plan.md).

Cloudflare automatic Git Builds were **disabled by the Owner on 2026-11-20** (Owner-reported; not independently verified here, so re-check in the Cloudflare dashboard before relying on it). They are not release authority and must stay off: the only release lane is the reviewed GitHub Actions workflow above. Legacy separate/per-PR Preview workflows are not release authority either; do not dispatch them. Preserve GitHub Environment secrets, actor/target checks and required protection. See [deployment](../deploy/cloudflare-fixed-preview-production.md) and the [M4 Admin plan](../deploy/m4-production-admin-plan.md).
