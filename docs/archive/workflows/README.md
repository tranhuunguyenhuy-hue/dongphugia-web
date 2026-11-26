# Archived GitHub Actions workflows (#510)

Moved here from `.github/workflows/` on 26/11/2026 (baseline `main` `df449b2`, Owner-approved list in #510 comment 7184097647).
Files here **cannot run**: GitHub only executes workflows under `.github/workflows/`. Nothing else was removed: Git history,
past runs, artifacts and evidence stay in GitHub; no secret, variable, environment, permission or ruleset was changed; the
Actions UI keeps listing these workflows (history) because their runs still exist.

## Why each is archived
| File | Reason | Still-needed pieces (kept outside this folder) |
|---|---|---|
| `v1-worker-release.yml` | Public-only Worker lane; refused to publish while Production carries the Admin; runbook forbids it | Rollback = `wrangler rollback <rollback_version_id>` recorded by `m4-production-admin-release.yml` ([v1-fast-release](../../ops/v1-fast-release.md)). `publish-m2/m3-fixed-preview.mjs` still query its runs by file name as a "Production busy" guard (API resolves archived names; returns history only) |
| `production-promotion.yml` | 0 runs; `workflow_call` with no caller | — |
| `runtime-backup.yml` | Schedule retired; its role `dpg_backup` does not exist in Production; replaced by `m4-production-backup.yml` | `scripts/backup/*` |
| `existing-state-backup.yml` | Phase-2 backup capability bootstrap/rehearsal (05/11) | `scripts/backup/existing-state/*` (used by `m4-production-backup.yml`, tested by `existing-backup-source-validation.yml`) |
| `supabase-backup-role-bootstrap.yml`, `supabase-database-preflight.yml`, `supabase-management-token-preflight.yml` | One-time setup/preflight (05/11) | `scripts/backup/*` |
| `supabase-runtime-rehome.yml` | One-time catalogue re-home (10/2026), 0 runs | `scripts/backup/*` |
| `b11-private-rewrap.yml`, `c-actions-recovery.yml`, `c-actions-original-authentic-recovery-go-6442512635.yml` | One-time recovery/re-wrap (10/2026) | `scripts/backup/b11_*`, `c-actions-*` |
| `catalogue-checkpoint-vault-audit.yml` | 0 runs | `scripts/catalogue-direct/vault-checkpoint-audit.mjs` |
| `catalogue-direct-migration.yml` | M1–M3 migration done; its PR `contract-tests` duplicated `quality` (`npm test` runs `scripts/catalogue-direct` incl. the PostgreSQL integration test on the same service) | `scripts/catalogue-direct/*`; environment `catalogue-direct-migration` (still used by `v1-fixed-preview.yml`) |
| `homepage-quality.yml` | Manual-only, not a required gate | Homepage tests, `scripts/quality/homepage-scope.mjs`, Lighthouse/Playwright configs |

Contract tests for these files still run in `quality`, reading them from this folder, so a restore stays valid.

## Restore (only with Owner approval in an issue)
1. `git mv docs/archive/workflows/<file>.yml .github/workflows/<file>.yml` in a PR; point its contract tests back to `.github/workflows/`.
2. Re-check the credential/environment it names (names in `docs/ops/credential-registry.yaml`), target project refs and the lane rules in `AGENTS.md`.
3. Merge with `quality` + Local Preview PASS; dispatch only for the approved purpose.
