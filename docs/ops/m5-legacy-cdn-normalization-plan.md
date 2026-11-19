# Legacy CDN URL normalization — inventory and plan (M5, #311)

Status: **plan only, nothing rewritten.** Production bulk update and any DNS change need Tech Lead + Owner approval.
Read-only inventory, Production `bonxyxluzlxfkdetryoo`, 2026-11-19.

## Decision
Stored URLs on `cdn.dongphugia.com.vn` (TLS broken) are normalized to the default Bunny pull zone `dpg-products.b-cdn.net`
of the same storage zone `dpg-products`. Path, filename and case are kept byte-for-byte; only scheme+host change.
The old custom hostname is not restored. Display-time normalization in Public (`live-public-catalogue.ts safeImage`,
`legacy-blog.ts`, `public-snapshot-catalogue.ts`) and Admin (`displayMediaUrl`) stays in place for old URLs anywhere
(caches, exports, third-party links). New uploads keep their current targets (`dpg-products.b-cdn.net/blog|banners`, publishing
`media.dongphugia.vn`; staging isolated). `cdn.dongphugia.vn` has 0 stored references.

## Exact scope (rows / distinct URLs)
| Field | Rows | Distinct | Notes |
|---|---:|---:|---|
| `product_images.image_url` | 99,977 | 52,231 | migrated 49,005, migrated-hita 1,428, products 1,119, hita 664, product_images 15 |
| `products.image_main_url` | 16,253 | 14,285 | migrated 13,130, migrated-hita 472, hita 313, products 225, optimized-home 123, product_images 22 |
| `product_descriptions.clean_html` (HTML `src`) | 10,897 rows | 9,354 | 17,169 occurrences: migrated, description_assets 103, hita 23, product_desc_images 3 |
| `products.description` (HTML) | 10,897 rows | 9,354 | same occurrences as `clean_html` |
| `products.specs` (JSON) | 23 rows | 61 | product_docs 55, documents 6 (PDF) |
| `product_documents.url` | 61 | 61 | same PDFs |
| `blog_posts` thumbnail / cover / content | 2 / 2 / 2 rows | 4 + 10 | `blog/` |
| `raw_html`, categories, subcategories, brands, partners, projects, spec values, publishing media | 0 | 0 | out of scope |

All matches are `https://`, no query string or fragment. Third-party hosts stay as they are and are **excluded**:
`cdn.hita.com.vn` (images 9,611 rows, documents 7,856 distinct URLs), `hita.com.vn` 2,211, `vietceramics.com` 20, Supabase archive (Blog 6).

## Delivery check (same storage object, new host)
- Stratified sample, 12 distinct URLs per folder (120): 118 HTTP 200 with the expected type (image/jpeg|png|webp, application/pdf).
- **Missing objects found:** `products/gach-op-lat/*.jpg` without `.original` (≈109 of 205 distinct URLs) return 404; the
  sibling `*.original.jpg` exists. These are broken today (display already maps to the new host). They are **excluded** from
  the rewrite; a separate fix (point to the `.original` sibling) needs its own approval because it changes the object.
- Before any batch, every distinct URL (~66k) is HEAD-checked on `dpg-products.b-cdn.net`; only 200 URLs are rewritten,
  everything else goes to an exclusion report.

## Execution plan (after approval)
1. Phase 0 — read-only: full HEAD check → `rewrite-set.csv` (old, new, status) and `excluded.csv`. Fresh verified backup (`m4-production-backup`, gate PASS).
2. Phase 1 — TEST `uybumsnyqpwcidjxmfsv`: apply the same SQL to the synthetic/public copy; run Public + Admin smokes and the `restoreHistoricalBlogArticleLinks`/`safeImage` tests.
3. Phase 2 — Production, Owner runs in SQL Editor, one table per transaction, batches of ≤5,000 rows by id:
   - Column fields: `update … set col = 'https://dpg-products.b-cdn.net' || substr(col, 29) where col like 'https://cdn.dongphugia.com.vn/%' and col in (verified set)`.
   - HTML/JSON: `replace(text, 'https://cdn.dongphugia.com.vn/', 'https://dpg-products.b-cdn.net/')` only for rows whose every old-host URL is in the verified set; JSON via `replace(specs::text, …)::jsonb`, validated by re-casting.
   - Each batch writes `(table, id, column, old_value)` to `dpg_control.m5_cdn_rewrite_ledger` first (reversible), then updates; triggers/`updated_at` untouched where possible; `version` not bumped.
   - After each batch: row counts, `count(*) where like old host` decreases by exactly the batch size, Public PLP/PDP smoke.
4. Rollback: `update … set col = l.old_value from ledger l where …` per batch; data rollback is independent of Worker rollback.
5. DNS for `cdn.dongphugia.com.vn`: unchanged. Removal only after Phase 2 completes and 30 days of zero hits, with explicit Owner approval.

Cost: $0 (no new zone, HEAD requests only). Database growth: ledger ≈ 130k rows ≈ 25 MB (DB 231/500 MB).
