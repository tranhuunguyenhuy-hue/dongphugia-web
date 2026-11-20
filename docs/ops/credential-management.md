# V1 credential operations

Authority: Issue #348. Name-only registry: [credential-registry.yaml](credential-registry.yaml).
Owner controls credentials and approvals; INFRA maintains this registry. Milestone agents consume capabilities through existing protected workflows. No secret value, password, verifier, private key or digest belongs in this documentation.

## Scope and evidence

Refreshed 2026-11-20 against current `main` after the #348 phase-1 cleanup (23 workflow files; 14 obsolete ones were removed by #420 and 10 more by the Owner-approved phase 1). The registry enumerates every workflow's jobs/environments, triggers and secret/variable references derived from source, including the Production Admin release, backup and function lanes added after the first snapshot (2026-11-16, `e97602e`). GitHub workflow states were not re-observed (UNKNOWN). The 10 environment names were confirmed by the GitHub API on 2026-11-16. Actual repo/org/environment credential inventories remain UNKNOWN: the connected integration cannot access the Environment secret-management public-key endpoint (403). The two M2 inputs were proved usable by runner 43839281437. No inference of an unconfigured/unused secret is made from missing code references. `LEGACY` describes the superseded consumer, not authorization to delete its credentials.

To complete actual inventory, Owner exports **names and metadata only** from repo/org and each existing Environment: secret names/update times, variable names (omit values), org repository visibility, protection rules and branch restrictions. Reconcile by scope and name, since the same name may resolve differently across repo/org/Environment. Never export secret values. Dynamic environment expressions in historical workflows are references, not evidence that the rendered Environment exists.

## Maintained capabilities

| Capability | Existing scope | Consumer / resource | Provision and rotation |
| --- | --- | --- | --- |
| Production release | `Production` | `m4-production-admin-release.yml` (release lane) and `v1-worker-release.yml` (Public-only rollback tool, refuses to publish while Production carries the Admin); `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ADMIN_API_HMAC_SECRET`, `ADMIN_PRODUCTION_MEDIA_KEY`, `V1_PUBLIC_HYPERDRIVE_ID` variable | Owner provisions narrowly scoped Cloudflare access. Review target and rollback before any rotation. IDs belong in Variables. Never dispatch Production release as credential verification. |
| M2 snapshot SELECT | `catalogue-direct-migration` | `v1-fixed-preview.yml` prepare; `M2_PUBLIC_READ_DATABASE_URL`, `DIRECT_TARGET_CA`; role `dpg_m2_snapshot_read` | Role only reads 14 Public tables under RLS; default READ ONLY, no membership/write/DDL/BYPASSRLS. Owner stores a separate password privately and sets the existing secret directly. `verify-read-access` on reviewed main proves actual login/TLS/counts before capture/publication. Do not reset Production role or postgres. |
| Fixed staging publisher | `cloudflare-staging` | `v1-fixed-preview.yml` publish; `CLOUDFLARE_API_TOKEN`; named staging in existing Worker | Existing protected publisher only. Preview receives snapshot, no DB credential/Hyperdrive. Service token used for UAT is short lived and cleaned up by publisher. Never create an Environment per issue. |
| Production backup (M4/M5) | `runtime-backup` | `m4-production-backup.yml`; `M4_BACKUP_READER_DATABASE_URL` (least-privilege `dpg_backup_reader`), `M4_BACKUP_DATABASE_URL` (owner fallback, removal needs Owner approval after a successful reader run), `BACKUP_AGE_PRIVATE_KEY`, `BACKUP_FAILURE_WEBHOOK_URL` | Daily 19:41 UTC with encrypted restore rehearsal; runbook `m5-backup-recovery-runbook.md`. Rotate only with a verified restore. |
| Edge Function deploy | `m4-production-functions` (Production), `m3-test-functions` (TEST) | `m4-production-function-deploy.yml`, `m3-admin-api-deploy.yml`; `SUPABASE_PRODUCTION_ACCESS_TOKEN`, `SUPABASE_TEST_ACCESS_TOKEN`, `ADMIN_API_HMAC_SECRET`, `M3_ADMIN_API_HMAC_SECRET` | Keep Production and TEST tokens/secrets separate. |
| Runtime backup / restore (legacy runtime project) | `runtime-backup` and existing rehearsal configuration | `runtime-backup.yml`, `existing-state-backup.yml`; database URLs, AGE identity/recipient, failure webhook and management token where referenced | Preserve schedules and decrypt/restore capability. Rotate only with verified encrypted backup, independent retained decrypt key, isolated restore proof and rollback. Do not archive this lane to reduce workflow count. |
| Catalogue migration / vault | `catalogue-direct-migration` | `DIRECT_*` references in registry | Preserve recovery dependencies. M2 reader reuses this scope temporarily; do not move it during M2. Historical source/import/setup credentials require dependency review before retirement. |
| Supabase bootstrap/rehome | `runtime-backup` | `SUPABASE_*` references in registry | Retain artifacts and recovery procedures. Historical workflows are manual; review disable/archive independently from credential rotation. |
| Bunny media / Google Sheets / publishing | Runtime and legacy configuration; actual store scope UNKNOWN | Consumer-specific runtime settings, including production-candidate variable `PRODUCTION_PUBLISHING_BUNNY_CDN_HOSTNAME` (its only consumer, `production-candidate`, was removed in phase 1; the variable is NOT touched) | Workflow references do not establish runtime secret inventory. Verify Worker/legacy runtime configuration name-only with Owner before moving or rotating; credentials must remain server-side. This P1 does not start M3/M5 or audit V2. |

## Retirement proposals — review only

- Retain sole Production release, fixed M2 publisher, required CI and backup/restore workflows. Retain source-validation PR checks. Performance monitoring remains scheduled; its failing budget is not credential evidence.
- Already removed by PR #420 (no remaining source consumer; their credentials are NOT touched and are listed under `references_without_remaining_source_consumer`): `public-production-worker`, `staging-ghcr`, `catalogue-checkpoint-key`, `catalogue-direct-setup`, `catalogue-preview-diagnostic` and the one-time M3/M4/M5 and recipient-diagnostic jobs. Removed in #348 phase 1 (10 Owner-approved removals, no secret/variable/Environment touched): `c-actions-original-authentic-recovery-once`, `leo560-shadow-import`, `catalogue-public-preview`, `catalogue-public-preview-v2`, `environment-worker-ci`, `environment-worker-publish`, `pr-preview-build`, `pr-preview-cleanup`, `pr-preview-publish`, `production-candidate`. **`production-promotion` was approved but deferred:** it declares `workflow_call` in a public repository, so cross-repository callers cannot be ruled out (UNKNOWN); it stays until that is resolved. Still retained and NOT approved for removal: the six deferred workflows (`supabase-backup-role-bootstrap`, `supabase-database-preflight`, `supabase-management-token-preflight`, `supabase-runtime-rehome`, `catalogue-direct-migration`, `catalogue-checkpoint-vault-audit`), the UNKNOWN `c-actions-recovery` and the five KEEP recovery workflows. Review for archive or disable Check callers, manual recovery dependencies, retained artifacts and Owner acceptance first. YAML workflow names containing `v2` are historical V1-repo filenames; this is no authority to access V2 resources.
- Review `Preview`, `staging`, old Production-labelled Environments and `pr-preview` for archival after proving no live consumer or recovery dependency. Keep existing branch protections and reviewer gates. Dynamic environment consumers need special review.
- Do not mark any credential UNUSED until actual configured name inventory and dependency verification agree. No delete, move, rotate, workflow-disable or protection mutation is included in this PR.

## Safe operational sequence

1. Resolve exact resource, credential owner, existing scope and consumer in the registry. Confirm current main, active releases and caller dependencies.
2. Prepare a reviewable scoped change and recovery plan. For public IDs use existing Variables; never duplicate a credential merely for a new ticket.
3. Owner enters new credentials directly into the intended store over a private channel. Passwords live in Owner's password manager; never in SQL Editor history or logs. Supabase Database → Roles can reset **only the intended independent role** when specifically authorized.
4. Verify using the actual consumer and narrow operation. Record identity, TLS, privilege/count results and run URL only. On error report sanitized diagnostics; never print environment dumps or full URLs.
5. Retain the previous authorized recovery capability until verification and approval permit retirement. Update scope/name/consumer evidence in registry.

## Recovery boundaries

For Production incident: stop overlapping releases, inspect Worker version/traffic/health and DB auth diagnostics read-only. Preserve `dpg_public_catalogue`, Hyperdrive and data. Do not rotate/reset credentials to diagnose. Production code rollback cannot restore DB writes. Use the accepted Production recovery runbook and target-specific Owner authorization for mutations.

For M2: use [fixed Preview runbook](../deploy/m2-fixed-preview-runbook.md). Recovery re-uploads a verified accepted artifact to named staging only; first deployment without accepted predecessor has recovery UNKNOWN. Credential PASS does not constitute hosted UAT or Gate B acceptance.

## Owner decisions still open (none is PASS; nothing here is authorised)

1. Export name-only secret/variable metadata per scope so the registry can be reconciled with the real store (inventory remains UNKNOWN).
2. Remove the fallback `M4_BACKUP_DATABASE_URL` after a successful `dpg_backup_reader` run, and decide any `postgres` password rotation.
3. Archive legacy Environments (`pr-preview`, `Preview`, `staging`, old Production-labelled ones) only after proving no consumer or recovery dependency.
4. Decide the remaining tier-2 workflows (6 deferred, 1 UNKNOWN), which determines which credentials can then be retired. After phase 1, the credentials whose last consumer was removed are listed in the registry under `references_without_remaining_source_consumer`: they stay in the store until an Owner-approved retirement.
