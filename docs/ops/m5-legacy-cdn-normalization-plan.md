# Legacy CDN URL normalization — evidence, design and Owner runbook (M5, #311)

Status: **ready to run, nothing executed on Production.** Evidence: Phase 0 + scratch rehearsal, run 44623570863 (main `4904fec`),
artifact `m5-cdn-phase0` (generated SQL, exclusion list, decisions, rehearsal log; 7 days, regenerated on demand).

## Decision and rule
Stored URLs on `cdn.dongphugia.com.vn` (no DNS record, TLS dead) become `https://dpg-products.b-cdn.net/` (the default pull zone of the
same storage zone `dpg-products`). **Exact origin substitution only** (anchored `https://cdn.dongphugia.com.vn/` → new origin; no character
offsets). Path bytes, case and percent-encoding never change. Display normalization in Public/Admin stays, so any old URL that remains
keeps working. `cdn.dongphugia.vn`: 0 references. DNS is untouched; there is nothing to remove.

## Phase 0 (read-only) results
| Item | Value |
|---|---|
| Objects in zone `dpg-products` (exact listing) | 191,580 |
| Stored references / distinct paths | 150,694 / 53,857 (duplicates not counted as assets) |
| Byte-exact object present | 53,731 |
| Present only after decoding (`%`) or collapsing `//` | 16 (5 + 11): excluded, left on the old host |
| Missing objects | 110, all `products/gach-op-lat/*.jpg` (the `.original.jpg` sibling exists) |
| Delivery checks | 536 HEAD requests, headers only, 4 parallel: 426 × 200 (image/jpeg, png, webp), 110 × 404 (= the missing ones) |
| Excluded URLs | 126 (110 missing + 16 non-exact) |
Fields: `product_images.image_url` 99,977 rows; `products.image_main_url` 16,253; HTML `product_descriptions.clean_html` and
`products.description` 17,169 `src` each (10,897 rows); `products.specs` 61 PDF refs (23 rows); `product_documents.url` 61. Blog (2+2+10
refs) stays on the old host: Public's legacy-Blog rule recognises only that form. Third-party hosts (cdn.hita.com.vn, hita.com.vn,
vietceramics, Supabase archive) are never touched.

## Broken tile images (separate, targeted)
110 files / 111 column values (`product_images` + `products.image_main_url`) point to a missing `*.jpg`. Each repair needs: sibling
`<name>.original.<ext>` present in the listing, delivered by the pull zone as `image/*` (200), and provenance (same product already references
the sibling, or the file code is in the product SKU/slug). Result: 110/110 confirmed, 0 rejected. `004` repairs only those, only while the stored
value still equals the broken URL, with a ledger. No blanket extension substitution.

## Measured cost on a scratch copy of Production (non-superuser executor, Production ownership)
- **One transaction is not safe**: +124 MB database, WAL 222 MB, ledger 29 MB; it ends above the 350 MiB hard stop, and so does a one-transaction rollback.
- **6 guarded batches** (product-id windows, each its own transaction; start guard 320 MB; autovacuum tuned in batch 1, reset after batch 6):
  +69.4 MB (peak = final), WAL 232 MB, ledger 25.4 MB, 127,058 values changed, 0 non-target columns changed, 0 rows lost.
- **Rollback in 6 batches**: peak +34 MB, exact (all original counts restored; an Admin edit made in between is kept).
- Projection for Production (242 MB now): ≈311 MB after the batches, ≈345 MB at the worst point of a rollback. Hard stop 367 MB (350 MiB), plan limit 500 MB. The extra size is permanent dead space (no VACUUM FULL: it locks the tables).
- Tile repair: 111 values, negligible.
- Actions minutes: ≈16 min per full rehearsal; Phase 0 = 536 HEAD requests (headers only, < 1 MB); no new paid resource.

## Safety design (all exercised in the rehearsal)
- Each update re-reads the row under lock and writes only if it still equals what was read; products.`version` + 1 once per changed product, so an open Admin editor gets VERSION_CONFLICT and reloads. An Admin edit that commits during a batch makes that product skipped by that batch; the next run picks it up (sweep). A second re-run changes nothing.
- Ledger `dpg_control.m5_cdn_ledger` (table, pk, column, md5 before/after as uuid). Rollback restores a field only if it still equals the migrated value and the reverse substitution reproduces the original.
- Mixed rows (old and new origin together), unquoted occurrences and rows containing an excluded URL are skipped, never partially rewritten.
- Triggers: only the free-tier headroom trigger (statement level); `updated_at` is not touched. Role: the Supabase `postgres` role (inherits `dpg_migration`), no new grant, no CI write credential, no public write path.

## Owner runbook (about 25 minutes, after approval)
0. Tech Lead dispatches a fresh `m4-production-backup` (backup + restore gate PASS) and regenerates the SQL from main. No Owner action.
1. Owner runs, in the Supabase SQL Editor of `dongphugia-production`, `002` batches 01 to 06, one run each, ~2 minutes apart. Each ends with a result table; expected final `remaining_old_origin`: images 127, `image_main_url` 1, everything else 0.
2. If a count is higher, run that batch again (sweep).
3. Owner runs `004` (111 repairs). Tech Lead then re-checks Public/Admin and PLP/PDP samples and records PASS/FAIL.
4. Rollback (only if needed): `003` batches 01 to 06, same pacing. Worker rollback is independent.
To keep Owner effort low, the SQL is delivered through one private page with copy buttons and a checklist (same pattern as the backup role).

## Not part of this change
Blog fields, the 16 non-exact URLs, PDFs outside the 61 document references, third-party hosts, DNS, deletions, new zones, PDF↔SKU attachment (post-M5).

## Storage and editorial media (inventory only)
- Zone `dpg-products` (default pull zone `dpg-products.b-cdn.net`): 191,580 objects; Admin uploads for products, Blog covers/thumbnails and banners currently land here (`blog/`, `banners/`; Public accepts only the generated names under `blog/`).
- `media.dongphugia.vn` (valid TLS) is a CNAME of `dpg-publishing-production.b-cdn.net`, the Publishing zone; it delivers the same objects (HTTP 200, webp). Four existing Blog images use it or its default host. Switching new Admin uploads to it needs that zone's storage key and the Public allow-list change: not done, not needed for the CDN work (documented transition gap, no functional gap today).
- Other zones/pull zones seen in code: `dpg-publishing-production`, `dpg-publishing-staging`, `dpg-media-staging` (all exist, TLS valid). Sizes, traffic and any further zone need the Owner's Bunny dashboard lists (Storage Zones, Pull Zones: name, size/files, 30-day bandwidth). No account key requested, no consolidation or deletion proposed before that.
