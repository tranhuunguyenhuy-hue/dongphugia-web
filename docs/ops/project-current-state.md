# Current checkpoint — M4 accepted; M5 audit and bounded fixes in progress

Updated 2026-11-19 (UTC) by Claude Code under [#311 / 7013573147](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/311#issuecomment-7013573147). M4 Owner UAT PASS: [#310 / 7013550757](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/310#issuecomment-7013550757). Latest decisions: [Master #306](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/306), [#311 CDN scope / 7007320247](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/311#issuecomment-7007320247).

## Status

- M1, M2, M3, M4: DONE / Owner UAT PASS. Active milestone: M5 (#311).
- Production runs the combined Worker (canonical Public + Admin under `/admin-next`, legacy `/admin*` → 302) from main `24a5479`, Worker version `e7dda372-7cfa-418f-b729-b8d34ed5dcb6`; Edge Function `admin-api` on `bonxyxluzlxfkdetryoo`; `production_writes_allowed = true`; migrations `001`/`002` applied; 1 admin (`admin@dongphugia.vn`).
- Scope: catalogue master data is Dev-managed (read-only lookups). Partners/Projects hidden in the Admin (gateway 404) pending M5 review. Homepage hero banners are DB-managed (`dpg_app.banners`, HERO, `sort_order`) with the verified historical hero as automatic fallback.
- New uploads go to `dpg-products.b-cdn.net`; the legacy host `cdn.dongphugia.com.vn` has a TLS problem and is mapped to that host on display (Admin) and in Public rendering. Stored URLs are unchanged.

## Release and rollback

- Release lane: `.github/workflows/m4-production-admin-release.yml` (verify/publish, exact SHA, active version must equal the recorded rollback target, secrets via `--secrets-file`, paced smoke with bounded identity retry, no automatic rollback). `v1-worker-release.yml` refuses to publish while Production carries the Admin.
- Function: `m4-production-function-deploy.yml` (Supabase CLI pinned 3.2.0). Rollback order: Worker `wrangler rollback <previous version>` (does not undo SQL) → function delete → banner grant/policy revoke → `002`/`001` rollbacks; restore only for data loss.

## Backup

- `m4-production-backup.yml`: daily 19:41 UTC, encrypted (age), SHA256SUMS, isolated restore rehearsal comparing per-table row counts and schema objects, visible failure signal. The legacy `runtime-backup.yml` schedule is retired (its target project was deleted).
- Credential: currently the project owner role via `M4_BACKUP_DATABASE_URL`; least-privilege replacement (`dpg_backup_reader`) proposed in #311, Owner action.

## Environment (verify before writes)

- Production Worker `dongphugia-v1-public-production` (Hyperdrive `905f5791…`, role `dpg_public_catalogue`); fixed Preview `staging` inside it (TEST `uybumsnyqpwcidjxmfsv`).
- Denylisted historical database ref `tlmgudfhsyzayiazuugf` (deleted runtime project) is neither of the approved targets. Do not use it.

## Next steps

1. M5 report and Owner UAT (#311): stability, backup/recovery, functional audit, CDN/Bunny inventory, backlog.
2. Owner decisions listed in the M5 report (least-privilege backup role, CDN/storage cleanup proposals); no deletions or DNS changes without separate approval.

## M2 recovery — time-sensitive

[Artifact #14253475719](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/actions/runs/43918034548/artifacts/14253475719), 37,736,963 bytes, SHA-256 `74cc0631ad1c37898f4b76476a50963b2518332ff11c0af52b2f965499c72bc0`; reported expiry 23 Nov 2026. Codex private workspace copy `/workspace/m2-recovery/m2-fixed-preview-00914b73.zip` verified by Agent; not necessarily accessible to Claude. Preserve/verifiably download to private storage available to Owner before expiry, never upload to public repo. See [M2 rollback runbook](../deploy/m2-fixed-preview-runbook.md). Re-upload is staging only; no automatic Production rollback.
