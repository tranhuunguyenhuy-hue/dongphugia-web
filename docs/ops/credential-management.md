# V1 credential operations

Authority: Issue #348. Name-only registry: [credential-registry.yaml](credential-registry.yaml).
Owner controls credentials and approvals; INFRA maintains this registry. Milestone agents consume capabilities through existing protected workflows. No secret value, password, verifier, private key or digest belongs in this documentation.

## Scope and evidence

Snapshot source is `e97602e8569dcac5177a499e68330ed7be017d8d`, observed 2026-11-16. Registry enumerates 38 workflow files, their jobs/environments, triggers, GitHub workflow states and secret/variable references. GitHub API confirmed 10 environment names. Actual repo/org/environment credential inventories remain UNKNOWN: the connected integration cannot access the Environment secret-management public-key endpoint (403). The two M2 inputs were proved usable by runner 43839281437. No inference of an unconfigured/unused secret is made from missing code references. `LEGACY` describes the superseded consumer, not authorization to delete its credentials.

To complete actual inventory, Owner exports **names and metadata only** from repo/org and each existing Environment: secret names/update times, variable names (omit values), org repository visibility, protection rules and branch restrictions. Reconcile by scope and name, since the same name may resolve differently across repo/org/Environment. Never export secret values. Dynamic environment expressions in historical workflows are references, not evidence that the rendered Environment exists.

## Maintained capabilities

| Capability | Existing scope | Consumer / resource | Provision and rotation |
| --- | --- | --- | --- |
| Production release | `Production` | `v1-worker-release.yml`, existing V1 Worker; `CLOUDFLARE_API_TOKEN`, account ID, `V1_PUBLIC_HYPERDRIVE_ID` variable | Owner provisions narrowly scoped Cloudflare access. Review target and rollback before any rotation. IDs belong in Variables. Never dispatch Production release as credential verification. |
| M2 snapshot SELECT | `catalogue-direct-migration` | `v1-fixed-preview.yml` prepare; `M2_PUBLIC_READ_DATABASE_URL`, `DIRECT_TARGET_CA`; role `dpg_m2_snapshot_read` | Role only reads 14 Public tables under RLS; default READ ONLY, no membership/write/DDL/BYPASSRLS. Owner stores a separate password privately and sets the existing secret directly. `verify-read-access` on reviewed main proves actual login/TLS/counts before capture/publication. Do not reset Production role or postgres. |
| Fixed staging publisher | `cloudflare-staging` | `v1-fixed-preview.yml` publish; `CLOUDFLARE_API_TOKEN`; named staging in existing Worker | Existing protected publisher only. Preview receives snapshot, no DB credential/Hyperdrive. Service token used for UAT is short lived and cleaned up by publisher. Never create an Environment per issue. |
| Runtime backup / restore | `runtime-backup` and existing rehearsal configuration | `runtime-backup.yml`, `existing-state-backup.yml`; database URLs, AGE identity/recipient, failure webhook and management token where referenced | Preserve schedules and decrypt/restore capability. Rotate only with verified encrypted backup, independent retained decrypt key, isolated restore proof and rollback. Do not archive this lane to reduce workflow count. |
| Catalogue migration / vault | `catalogue-direct-migration` | `DIRECT_*` references in registry | Preserve recovery dependencies. M2 reader reuses this scope temporarily; do not move it during M2. Historical source/import/setup credentials require dependency review before retirement. |
| Supabase bootstrap/rehome | `runtime-backup` | `SUPABASE_*` references in registry | Retain artifacts and recovery procedures. Historical workflows are manual; review disable/archive independently from credential rotation. |
| Bunny media / Google Sheets / publishing | Runtime and legacy configuration; actual store scope UNKNOWN | Consumer-specific runtime settings, including production-candidate variable `PRODUCTION_PUBLISHING_BUNNY_CDN_HOSTNAME` | Workflow references do not establish runtime secret inventory. Verify Worker/legacy runtime configuration name-only with Owner before moving or rotating; credentials must remain server-side. This P1 does not start M3/M5 or audit V2. |

## Retirement proposals — review only

- Retain sole Production release, fixed M2 publisher, required CI and backup/restore workflows. Retain source-validation PR checks. Performance monitoring remains scheduled; its failing budget is not credential evidence.
- Review superseded `pr-preview-*`, `catalogue-public-preview*`, `environment-worker-publish`, `public-production-worker`, `production-promotion`, `staging-ghcr`, and one-shot recovery/bootstrap/import workflows for archive or disable. Check callers, manual recovery dependencies, retained artifacts and Owner acceptance first. YAML workflow names containing `v2` are historical V1-repo filenames; this is no authority to access V2 resources.
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
