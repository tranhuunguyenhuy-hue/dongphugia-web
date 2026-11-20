# Current checkpoint — M4 accepted; M5 executed, awaiting Tech Lead verification and Owner UAT

Updated 2026-11-20 (UTC) by Claude Code under [#311 / 7013573147](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/311#issuecomment-7013573147). M4 Owner UAT PASS: [#310 / 7013550757](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/310#issuecomment-7013550757). Latest decisions: [Master #306](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/306), [#311 CDN scope / 7007320247](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/311#issuecomment-7007320247).

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
- Credential: least-privilege `dpg_backup_reader` via `M4_BACKUP_READER_DATABASE_URL` (login, BYPASSRLS, SELECT only on `dpg_app`/`dpg_control`, read-only default, 2 connections); `M4_BACKUP_DATABASE_URL` stays as fallback until the Owner approves removal. The restore gate hard-fails on any restore error, row-count, schema-object or ACL difference. Recovery runbook: `docs/ops/m5-backup-recovery-runbook.md`. Latest verified backup before the CDN change: run 44684740410 (`m4-44684740410`); first scheduled run 44653583453 succeeded (GitHub started it ~5h45m after the cron).

## Environment (verify before writes)

- Production Worker `dongphugia-v1-public-production` (Hyperdrive `905f5791…`, role `dpg_public_catalogue`); fixed Preview `staging` inside it (TEST `uybumsnyqpwcidjxmfsv`).
- Denylisted historical database ref `tlmgudfhsyzayiazuugf` (deleted runtime project) is neither of the approved targets. Do not use it.

## Media / CDN (M5, Option A, 20/11)

- Stored legacy-CDN URLs were normalised to `https://dpg-products.b-cdn.net/` by six guarded batches plus a targeted repair of 111 broken tile image refs (110 files, `.original.jpg` siblings): 137,980 ledger values, 16,252 products, `products.version` +16,363 as predicted, DB 242 -> 294 MB (hard stop 367 MB). Evidence/runbook: `docs/ops/m5-legacy-cdn-normalization-plan.md`; report #311 (comment 7032644022).
- Still on the old origin by design: 16 non-exact image paths (`%`-encoded or `//`) + 1 main image, Blog legacy images, third-party hosts. Display mapping stays. Ledgers `dpg_control.m5_cdn_ledger` / `m5_tile_ledger` enable the conditional batched rollback (`003`, not run).
- Bunny: 7 storage zones, 6 pull zones (dashboard 20/11). `cdn.dongphugia.com.vn` has no public DNS record. No deletion, hostname or DNS change authorised.

## Next steps

1. Tech Lead verification of the M5 Production result (#311 / 7032644022), then Owner UAT. Optional Cloudflare error check for the change window.
2. Owner decisions still open: removal of the fallback backup secret and any `postgres` password rotation; zone/hostname cleanup candidates (`dpg-publishing-production-r2`, `dpg-publishing-staging`, `dpg-v1-preview-*`, Bunny hostname `cdn.dongphugia.com.vn`); each needs its own dependency check and approval. Post-M5: PDF↔SKU attachment, hotlink independence, A4 print on the first real quote.

## M2 recovery — time-sensitive

[Artifact #14253475719](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/actions/runs/43918034548/artifacts/14253475719), 37,736,963 bytes, SHA-256 `74cc0631ad1c37898f4b76476a50963b2518332ff11c0af52b2f965499c72bc0`; reported expiry 23 Nov 2026. Codex private workspace copy `/workspace/m2-recovery/m2-fixed-preview-00914b73.zip` verified by Agent; not necessarily accessible to Claude. Preserve/verifiably download to private storage available to Owner before expiry, never upload to public repo. See [M2 rollback runbook](../deploy/m2-fixed-preview-runbook.md). Re-upload is staging only; no automatic Production rollback.
