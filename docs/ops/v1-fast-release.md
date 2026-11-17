# V1 CI/CD fast lane

One active milestone/branch/PR. Use the [shared policy](../../AGENTS.md) and [checkpoint](project-current-state.md). No parallel deployment paths.

1. Review affected source, focused tests, typecheck/build and PR against current milestone. Required GitHub status: `quality`; documentation-only changes skip expensive application checks, but code/test/workflow changes must use the actual required checks.
2. M2 `.github/workflows/v1-fixed-preview.yml` creates or restores captured Public-only snapshot for exactly the named Preview. It is not a ready M3 Admin publisher. M3 uses the combined Worker artifact with separate TEST roles/Hyperdrive/Access/media and actual hosted acceptance; complete the publisher within M3. Keep M2 rollback artifact private and verifiable.
3. For M4 only after Owner-accepted M3, adapt/reuse `.github/workflows/v1-worker-release.yml` for the exact accepted combined Admin build. Verify from reviewed protected main (`publish=false`), then explicit `publish=true` only when release gates and backup/rollback pass. Do not publish snapshot/default Public-only artifact as M4 Admin. Do not change DNS or production settings to make staging pass.
4. Record run, source/artifact/deployment/version, effective DB/roles, real live smoke, PASS/FAIL/UNKNOWN and rollback in assigned issue. Worker rollback does not restore SQL.

Cloudflare automatic Git Builds and legacy separate/per-PR Preview workflows are not release authority. Do not dispatch them. Preserve GitHub Environment secrets, actor/target checks, and current required protection. See [deployment](../deploy/cloudflare-fixed-preview-production.md).
