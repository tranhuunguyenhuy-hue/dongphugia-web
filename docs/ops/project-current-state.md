# Current checkpoint — M3 code complete (local/CI), hosted acceptance waiting on one Owner step

Updated 2026-11-18 (UTC) by Claude Code under the Owner delegation in [#360 comment 6988598277](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/360#issuecomment-6988598277). Working issue [#360](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/360); milestone [#309](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/309). Latest status comments: #360 / 6989649031, #309 / 6989916507.

## Status

- M1 and M2: DONE / Owner UAT PASS (unchanged).
- M3 (G4 architecture: static SPA + same-origin gateway + Supabase Edge Function `admin-api` + narrow DB role): pilot gate PASS ([#360 / 6988532875](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/360#issuecomment-6988532875)); all 12 legacy Admin areas ported in PR #378 (merged, main `11b99a4`). Local/CI evidence: 49 PostgreSQL/definition tests, 10 gateway tests, browser e2e 18/18 PASS (`scripts/m3/local-e2e`). **Hosted acceptance: UNKNOWN.**
- M4: package prepared (`supabase/m4-production/001+002` + rollbacks, tested on a Production-shaped database), **not executed**. M5: partial (publisher resilience, cache TTL 45 s); backlog open.

## Blocked on the Owner (nothing else blocks M3 hosted acceptance)

1. Run `supabase/m3-test/005_m3_test_admin_resources.sql` in the SQL Editor of `dongphugia-staging` (ref `uybumsnyqpwcidjxmfsv`). The Supabase MCP DDL confirmation is never answered while the Owner is offline.
2. Allow a temporary Cloudflare Access service token for the hosted acceptance run (revoked afterwards).
3. For M4 (Production): set `dpg_control.target_contract.production_writes_allowed = true`; provide a Supabase token limited to project `bonxyxluzlxfkdetryoo` plus function/Worker secrets; create the first admin (Production `admin_users` is empty; hash only). Details: [runbook](../deploy/m3-admin-api-runbook.md).

## Environment (verify before writes)

- Production Worker `dongphugia-v1-public-production`: version `edcb15b2-bcb0-46d6-b0c6-31efb495a8c7` (deployment `116da805…`, source `e73fb13`), Public-only; rollback targets `5577b78d…` then `b179b339…`. **Unchanged by this work.**
- Fixed Preview `staging`: runs main `a2468e1` (pilot UI + pilot function). Do **not** deploy the new function or publish the new SPA before `005` is applied: the new SPA no longer uses the pilot `/products` routes.
- Supabase: Production `bonxyxluzlxfkdetryoo`; TEST `uybumsnyqpwcidjxmfsv` (function `admin-api` deployed from `a2468e1`). Production schema differs from TEST (no `products.version`; `audit_logs` has no `request_id/changed_fields`): handled by the M4 migration and portable audit rows.

## Next steps (in order)

1. After Owner step 1: dispatch `m3-admin-api-deploy.yml`, publish staging with `v1-fixed-preview.yml publish-m3`, run hosted acceptance (≥100 first-attempt requests/surface, Chromium + WebKit × desktop/mobile, p95, Admin→Public freshness ≤ 60 s, replay/CSRF negatives, cleanup, token revocation). Report PASS/FAIL/UNKNOWN in #360/#309.
2. Only after M3 technical acceptance and the Owner items for M4: backup (`runtime-backup.yml`), Production migrations, function deploy, Worker release with `/admin` → `/admin-next/` redirect and a non-Prisma upload path, verification and rollback readiness.
3. M5 backlog: PLP `sort`/`price`/`page=1` URLs (product decision), legacy "quick create product" modal, CSP via response headers, hosted WebKit run.

## M2 recovery — time-sensitive

[Artifact #14253475719](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/actions/runs/43918034548/artifacts/14253475719), 37,736,963 bytes, SHA-256 `74cc0631ad1c37898f4b76476a50963b2518332ff11c0af52b2f965499c72bc0`; reported expiry 23 Nov 2026. Codex private workspace copy `/workspace/m2-recovery/m2-fixed-preview-00914b73.zip` verified by Agent; not necessarily accessible to Claude. Preserve/verifiably download to private storage available to Owner before expiry, never upload to public repo. See [M2 rollback runbook](../deploy/m2-fixed-preview-runbook.md). Re-upload is staging only; no automatic Production rollback.
