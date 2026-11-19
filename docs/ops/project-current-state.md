# Current checkpoint — M3 technical gate evidence complete on Staging; M4 prepared, waiting for Owner acceptance

Updated 2026-11-19 (UTC) by Claude Code under the Owner direction in [#309 / 7004192339](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/309#issuecomment-7004192339) (earlier delegation: [#360 / 6988598277](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/360#issuecomment-6988598277)). Working issue [#360](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/360); milestone [#309](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/309). Latest decisions: [Master #306](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/306) and [#360 / 6999610211](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/360#issuecomment-6999610211). Latest status comments: #360 / 6990205607, #309 / 6989916507.

## Status

- M1 and M2: DONE / Owner UAT PASS (unchanged).
- M3: Owner visual/scope UAT PASS (shadcn/ui Zinc, brand-blue primary CTA, softer shadows, Dev-managed master data; [#309 / 7004192339](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/309#issuecomment-7004192339)). Final hosted technical gate on main `d022689` (function deployed by run 44495653339, Worker published at `30e1b69`, deployment `1351eb11…`): API 52/52 (3 roles + Owner), UI 25 steps x 7 contexts (Chromium and WebKit; desktop, iPad portrait/landscape, mobile), replay/signature/CSRF-marker 9/9 (run 44494252070), freshness 0.6-0.7 s, first-attempt latency within the 3 s gate, zero 5xx. Evidence: [docs/ops/m3-final-gate](m3-final-gate/). Owner acceptance of the technical gate is pending.
- Scope: catalogue master data (categories, brands, taxons, product types, specifications, origins/colors/materials) is Dev-managed (no Admin screen or write path for any role; lookups are read-only and need `products:read`). The legacy `/admin` UI is retired on staging (redirects to `/admin-next/`); its source and artifacts remain in the repository. See the [runbook](../deploy/m3-admin-api-runbook.md).
- M4: plan and package prepared, **nothing executed**: [m4-production-admin-plan.md](../deploy/m4-production-admin-plan.md). M5: backlog open; M4/M5 stay on HOLD until the Owner accepts M3.

## Blocked on the Owner (only after M3 acceptance, in this order)

1. Keep a durable copy of the M2 recovery artifact (section below) or confirm one exists.
2. Create a Supabase token limited to Production (`bonxyxluzlxfkdetryoo`) and a fresh Production `ADMIN_API_HMAC_SECRET` as GitHub environment secrets; provide the Production media key/host as Worker secrets.
3. At M4 start: set `dpg_control.target_contract.production_writes_allowed = true`; create the first Production admin (hash only). Details: [M4 plan](../deploy/m4-production-admin-plan.md).

## Environment (verify before writes)

- Production Worker `dongphugia-v1-public-production`: version `edcb15b2-bcb0-46d6-b0c6-31efb495a8c7` (deployment `116da805…`, source `e73fb13`), Public-only; rollback targets `5577b78d…` then `b179b339…`. **Unchanged by this work.**
- Fixed Preview `staging`: main `30e1b69` (Worker) with the function from main `d022689`; TEST database has `006_m3_test_admin_scope_revoke` applied (Owner ran it in the SQL Editor; verified read-only).
- Supabase: Production `bonxyxluzlxfkdetryoo` (read-only checks only: writes flag `false`, no admin users, 17,752 products); TEST `uybumsnyqpwcidjxmfsv`. Production schema differs from TEST (no `products.version`; `audit_logs` has no `request_id/changed_fields`): handled by the M4 migration and portable audit rows.

- Denylisted historical database ref `tlmgudfhsyzayiazuugf` is neither of the approved targets. Do not use it.

## Next steps (in order)

1. Owner reviews the M3 technical report in #309 and accepts or lists defects.
2. M4 (after acceptance and the Owner items above): backup via `runtime-backup.yml`, migrations `001` then `002`, Production function deploy, Production Worker with the `/admin` redirect and a non-legacy upload path, verification and rollback readiness (full order in the M4 plan; the Production Worker code listed there still has to be written).
3. M5 backlog: PLP `sort`/`price`/`page=1` URLs (product decision), legacy "quick create product" modal, CSP via response headers, mobile Orders stat cards in two columns, Supabase CLI version pin in `m3-admin-api-deploy.yml` (GitHub API rate limit during `setup-cli`).

## M2 recovery — time-sensitive

[Artifact #14253475719](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/actions/runs/43918034548/artifacts/14253475719), 37,736,963 bytes, SHA-256 `74cc0631ad1c37898f4b76476a50963b2518332ff11c0af52b2f965499c72bc0`; reported expiry 23 Nov 2026. Codex private workspace copy `/workspace/m2-recovery/m2-fixed-preview-00914b73.zip` verified by Agent; not necessarily accessible to Claude. Preserve/verifiably download to private storage available to Owner before expiry, never upload to public repo. See [M2 rollback runbook](../deploy/m2-fixed-preview-runbook.md). Re-upload is staging only; no automatic Production rollback.
