# V1 CI/CD fast lane

One branch and one PR per issue. Policy: [AGENTS.md](../../AGENTS.md); state: [checkpoint](project-current-state.md). No parallel deployment paths; Production deploys are serialized and need Owner approval.

1. **Verify** affected source with focused tests, typecheck/build and PR. Required GitHub status: `quality`; documentation-only changes skip expensive application checks, but code, test and workflow changes must pass the actual required checks.
2. **Release the combined Public+Admin Worker** only with `.github/workflows/m4-production-admin-release.yml` from reviewed `main`: run `operation=verify` first, then `publish` for the exact approved SHA, with `rollback_version_id` equal to the version active right now and `owner_ready_confirmed=true`. Supabase function changes use `.github/workflows/m4-production-function-deploy.yml`.
3. **Do not** use `v1-worker-release.yml` (refuses to publish while Production carries the Admin), the M2 `v1-fixed-preview.yml` snapshot lane (recovery/staging only), or any publish of a snapshot/Public-only artifact over the Admin. Do not change DNS or Production settings to make a check pass.
4. **Record** in the assigned issue: run, source SHA, artifact, deployment and version ID, effective DB/roles, real live smoke, PASS/FAIL/UNKNOWN and the rollback target. Worker rollback does not restore SQL.

Cloudflare automatic Git Builds and legacy separate/per-PR Preview workflows are not release authority; do not dispatch them. Preserve GitHub Environment secrets, actor/target checks and required protection. See [deployment](../deploy/cloudflare-fixed-preview-production.md) and the [M4 Admin plan](../deploy/m4-production-admin-plan.md).
