# Current checkpoint — POST-M5, active development

Updated 2026-11-20 (UTC) under [#412](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/412). This file is the only mutable state snapshot; policy lives in [AGENTS.md](../../AGENTS.md). History (closed, not instructions): [#306](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/306) Master, [M1 #307](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/307), [M2 #308](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/308), [M3 #309](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/309), [M4 #310](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/310), [M5 #311](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/311) (Owner UAT PASS, closed 2026-11-20; [acceptance](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/311#issuecomment-7032996976)).

## Merged vs deployed — do not conflate

| | State | Verified |
| --- | --- | --- |
| `main` | `b463ea6` (PR #413, includes #411 homepage promotion popup) | git, 2026-11-20 |
| Deployed Production Worker | deployment `d3b28b83-4971-4b8d-a7b9-09701a1c1ca5`, version `e7dda372-7cfa-418f-b729-b8d34ed5dcb6`, 100%, message `M4 Admin release 24a547952d92` | Cloudflare API, read-only, 2026-11-20 |

The Production Worker was built from `24a5479` and has **not** been redeployed since. Merged changes after that SHA — including the homepage popup (#409/#411/#413) — are **not live**. Re-check the deployment before documenting or deploying: state changes with every release.

## Production

- Worker `dongphugia-v1-public-production` (account `d54f3402b9d112ab64d6135e0e3f1fb1`) serves canonical Public plus the accepted Admin under `/admin-next`; legacy `/admin*` redirects (302). Domains `www.dongphugia.vn`, `dongphugia.vn`.
- Database `dongphugia-production` (`bonxyxluzlxfkdetryoo`), schema `dpg_app`; Public Hyperdrive `905f5791…`, role `dpg_public_catalogue`. Edge Function `admin-api` on the same project; `production_writes_allowed = true`; migrations `001`/`002` applied; one admin account.
- Scope: catalogue master data is Dev-managed (read-only lookups). Partners/Projects are hidden in Admin (gateway 404) pending review. Homepage hero banners are DB-managed (`dpg_app.banners`, HERO, `sort_order`) with the verified historical hero as fallback.
- Staging: fixed Preview `staging` inside the same Worker, TEST database `dongphugia-staging` (`uybumsnyqpwcidjxmfsv`), Access-protected. Public-only M2 snapshot is recovery material, not the current staging artifact.
- Denylisted historical database ref `tlmgudfhsyzayiazuugf` (deleted runtime project) is neither approved target. Do not use it.

## Release and rollback

- Release lane: `.github/workflows/m4-production-admin-release.yml` (`verify` then `publish`; exact reviewed SHA; the active version must equal the recorded rollback target; secrets passed with `--secrets-file`; paced smoke; no automatic rollback; concurrency group `v1-production-worker-release`). `v1-worker-release.yml` refuses to publish while Production carries the Admin — never use it to publish.
- Function: `.github/workflows/m4-production-function-deploy.yml` (Supabase CLI pinned 3.2.0).
- Rollback order: Worker `wrangler rollback <previous version>` (does not undo SQL) → delete function → revoke banner grant/policy → `002`/`001` rollbacks; restore from backup only for data loss. Plan: [m4-production-admin-plan](../deploy/m4-production-admin-plan.md).

## Backup

- `.github/workflows/m4-production-backup.yml`: daily 19:41 UTC, encrypted (age), SHA256SUMS, isolated restore rehearsal comparing row counts and schema objects, hard-fails on any restore, row-count, schema-object or ACL difference. Legacy `runtime-backup.yml` schedule is retired (its target project was deleted).
- Credential `dpg_backup_reader` via `M4_BACKUP_READER_DATABASE_URL` (least privilege, read-only). `M4_BACKUP_DATABASE_URL` remains as fallback until the Owner approves removal. Runbook: [m5-backup-recovery-runbook](m5-backup-recovery-runbook.md). Latest verified backup after the CDN change: fresh encrypted backup and scratch restore gate PASS ([#311 acceptance](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/311#issuecomment-7032996976)). One scheduled run started about 5h45m after its cron — watch for drift.

## Media / CDN (M5 Option A, complete)

- Stored legacy-CDN URLs were normalised to `https://dpg-products.b-cdn.net/`: 137,980 ledger values, 16,252 products, 111 tile-image repairs. Production read-only verification: 17,752 products, 110,321 product images, database ~293 MB (hard stop 367 MB). Evidence: [m5-legacy-cdn-normalization-plan](m5-legacy-cdn-normalization-plan.md), [#311 / 7032644022](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/311#issuecomment-7032644022).
- Rollback ledgers `dpg_control.m5_cdn_ledger` and `m5_tile_ledger` are retained; rollback `003` was **not** run.
- Still on the old origin by design: 16 unusual image paths (`%`-encoded or `//`) + 1 main image, Blog legacy images, third-party hosts. Display mapping stays. The legacy host `cdn.dongphugia.com.vn` has no public DNS record. Bunny: 7 storage zones, 6 pull zones (dashboard 2026-11-20). No deletion, hostname or DNS change is authorised.

## Open work (none authorised unless its issue says so)

- [#412](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/412) agent documentation (this change).
- [#343](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/343) TOTO campaign landing (acceptance/live status UNKNOWN); PR [#414](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/pull/414) Codex campaign prize update (open, UI lane).
- [#348](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/issues/348) credential governance with PR [#350](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/pull/350) — pending Owner decision; actual secret-store reconciliation UNKNOWN.
- Owner-decision backlog from M5: remove the fallback backup secret and any `postgres` password rotation; Bunny zone/hostname cleanup candidates (`dpg-publishing-production-r2`, `dpg-publishing-staging`, `dpg-v1-preview-*`, `cdn.dongphugia.com.vn`), each needing a dependency check and approval; manufacturer PDF↔SKU attachment; hotlink independence; A4 print check on the first real quote; evidence before editing the 17 exception references; watch Cloudflare 1102 spikes on the next release.

## M2 recovery artifact — time-sensitive

[Artifact #14253475719](https://github.com/tranhuunguyenhuy-hue/dongphugia.com.vn/actions/runs/43918034548/artifacts/14253475719), 37,736,963 bytes, SHA-256 `74cc0631ad1c37898f4b76476a50963b2518332ff11c0af52b2f965499c72bc0`, reported expiry **2026-11-23**. The Owner reports having saved a copy locally on 2026-11-20; the checksum comparison is **UNKNOWN** until the Owner confirms it. Never upload it to a public repository. Re-upload is staging only; no automatic Production rollback. See [M2 rollback runbook](../deploy/m2-fixed-preview-runbook.md).
