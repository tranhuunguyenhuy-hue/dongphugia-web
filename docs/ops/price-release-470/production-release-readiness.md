# #470 — PRODUCTION RELEASE READINESS (giá Hita canonical, ngành vệ sinh)

**Trạng thái: CHUẨN BỊ, CHƯA THỰC THI.** Không có ghi Production/TEST/Staging, DDL, DML, DROP INDEX, import hay deploy nào đã xảy ra. Mọi bước dưới đây cần **Owner GO riêng** nêu đúng SHA + SQL + rollback. Cập nhật: 2026-11-24 (UTC).

## 1. Phạm vi đề xuất cho đợt đầu (để TL/Owner xem xét — tôi KHÔNG quyết phạm vi/ngưỡng)
**TOTO active — 2.057 SKU** (CSV checkpoint PR #463 `a361612a`):

| Kết quả Hita | Số SKU active | Ghi vào DB (`canonical_price_status`) |
|---|---|---|
| EXACT có giá | 1.543 | `PRICE_VERIFIED` + 3 giá |
| Liên hệ (Hita xác nhận) | 283 | `CONTACT_VERIFIED`, không giá |
| Ngừng kinh doanh | 49 | `DISCONTINUED` |
| Mơ hồ | 34 | `UNRESOLVED` |
| Không tìm thấy | 1 (id 2695, cần kiểm tra lại danh tính — URL kết thúc "/") | `NOT_FOUND` |
| NOT_CRAWLED / BLOCKED / UNKNOWN | 147 | **không ghi** → NULL: ẩn giá, "cần liên hệ", không thành CONTACT_VERIFIED |

Planner (dry-run, snapshot dựng từ inventory — chưa phải DB sống): **1.910 dòng đổi / 10 batch × 200, 0 dừng**, 28 WARN `LARGE_VOUCHER_REVIEW` (31–68%, cần Owner nhìn). 91,2% SKU active có kết luận; 8,8% (181) chưa xác minh.
Còn lại 3 nhóm ngành khác + thương hiệu sanitary khác giữ nguyên legacy/ẩn giá; chưa nằm trong đợt này.

## 2. Ứng viên và nguồn
- **Candidate SHA**: *chưa cố định* — sẽ là merge commit của #471+#472+#473+PR này **sau khi TL duyệt**. Đầu nhánh hiện tại: #471 `ff7f87b9`, #472 `f1722980`, #473 `c94f08be`, main `59cd8f69`. GO phải trích đúng SHA cuối.
- **CSV**: `docs/ops/hita-448/toto/toto_prices_review.csv` @ `a361612a7cd49deeadccae37b623daaca5fe9126`, sha256 `bda8301a86bc9f3d9c9ca01f7297c3183ee6efdcf82f1851b2757580d63ccf26`.
- **Cảnh báo dữ liệu bắt buộc xử lý trước GO**: toàn bộ 2.469 dòng EXACT đều có `price_valid_until = 2026-12-01` (nghi là mặc định của trang) → **crawl lại ngay trước cutover** (Codex), chạy lại Quality Gate `--mode import-review`, tính lại plan SHA. Inventory phải verify lại với Production ngay trước GO.
- **Go token** = `<candidateSha>:<csvSha256>:<planSha>` (planner in ra; chỉ khớp khi không có stop reason).

## 3. SQL dự kiến (đã viết, chưa apply) — `supabase/prod-prep/470/` + planner
| Thứ tự | Việc | File | Rollback |
|---|---|---|---|
| 0 | Sao lưu (mục 5) + đọc headroom | — | — |
| 1 | Cột + CHECK | `001_canonical_price_columns.sql` | `001_…_rollback.sql` (từ chối nếu còn dữ liệu) |
| 2 | Grants cột tối thiểu | `002_canonical_price_grants.sql` | `002_…_rollback.sql` |
| 3 | **HOÃN (không thuộc release)** — hàm order/quote sanitary-only (guard md5 baseline) | `003_runtime_order_quote_canonical.sql` | `003_…_rollback.sql` (khôi phục baseline, kiểm md5) |
| 4 | Import 10 batch (mỗi batch 1 transaction, guard plan SHA, row-count, stop rule 350 MiB − 8 MiB) | `prod-import.mts --out` → `batch-NNNN-apply.sql` | `batch-NNNN-rollback.sql` + `ledger.jsonl` |
| 5 | Đối soát: đếm theo status, kiểm CHECK, dung lượng | truy vấn đọc | — |
| 6 | Deploy Worker/Admin SPA candidate (Owner duyệt riêng) | workflow Production hiện có | Worker rollback (không hoàn tác SQL) |

Tuyệt đối không chạy 1→4 rồi mới nghĩ tới Worker: thứ tự cutover chi tiết ở mục 7 (cần quyết định kiến trúc).

## 4. Dung lượng
Đo 24/11: DB 279,74 MiB, trần trigger 350 MiB, headroom 70,26 MiB. Import 1.910 dòng ≈ **+3,85 MiB** (2.115 B/dòng, bảo thủ; planner chặn nếu < 8 MiB còn lại) → headroom sau ≈ **66–69 MiB**. Thêm cột = chỉ metadata (không rewrite bảng). Không cần DROP INDEX cho đợt này; kế hoạch index (PR #469) giữ nguyên là phương án dự phòng, chưa thực thi. VACUUM FULL `products` không an toàn trong headroom.

## 5. Sao lưu
1. **Bản sao giá legacy offline (1 bản)**: xuất đọc-only `id, sku, price, original_price, list_price, sale_price, online_discount_amount, price_display, price_state, price_source, price_confidence, price_updated_at` của 16.447 SKU sanitary (~0,35 MiB) + sha256; **giữ 7 ngày sau khi cutover ổn định được xác nhận**, chỉ để rollback, xoá sau đó (Owner #466). Chưa tạo — cần Owner GO vì chứa dữ liệu giá.
2. **Bản sao hệ thống riêng, 14 ngày**: `pg_dump` logic `dpg_app.products` + `orders`/`order_items`/`quote_*` + định nghĩa 3 hàm `runtime_*` (md5 baseline `a3c83a9b…`, `2de47a88…`), lưu ngoài nền tảng, kèm checksum. Gói Free không có PITR → đây là điểm khôi phục duy nhất. Chưa tạo.

## 6. Rollback
- Dữ liệu: `batch-*-rollback.sql` theo ledger (tuần tự ngược) → hoặc khôi phục từ bản sao 5.2. `version` chỉ tăng, không lùi.
- Hàm: `003 rollback` (đơn đã tạo trong lúc 003 chạy giữ nguyên `discount/total`).
- Schema: `002`, `001` rollback (từ chối nếu còn giá trị — phải rollback dữ liệu trước).
- Worker rollback tách riêng và **không** hoàn tác SQL; ngược lại cũng vậy.
- Stop rule: dừng ngay nếu lệch row-count, lệch plan SHA, headroom < 8 MiB, hoặc lỗi guard — không tự retry.

## 7. KIẾN TRÚC GIÁ PUBLIC — Owner chọn PHƯƠNG ÁN 1: Live PostgreSQL qua Hyperdrive (thay thế A)
**Thực tế đã xác minh (đọc-only, 24/11):** Worker `dongphugia-v1-public-production` chạy `PUBLIC_CATALOGUE_SOURCE=postgresql` + Hyperdrive `PUBLIC_DB` (role `dpg_public_catalogue`). Giữ nguyên; **không** thêm Worker/binding/kết nối/chi phí, **không** chuyển sang snapshot. Snapshot giữ vai trò rollback/Preview. Hiện Public Production không hiển thị giá nào (role không đọc cột legacy).

**Code (PR #476, base #475 → #471; tích hợp ở nhánh `claude/470-pricing-release-candidate`):** cùng một DTO `hita-exact-v1` (`public-canonical-pricing.mjs`, #475) dùng cho snapshot lẫn live; `live-public-catalogue.ts` đọc đúng 4 cột đã grant ở 002 trong **cùng câu SELECT** (1 truy vấn/trang, không N+1); phạm vi `thiet-bi-ve-sinh` × brand `toto`; cờ **`PUBLIC_CANONICAL_PRICING=on`** (mặc định TẮT, chỉ có hiệu lực khi `APP_ENV=production`). Cache HTML Worker: PDP/PLP/home/category TTL **45 s**, không phục vụ quá TTL (`page-cache.ts`); trang tĩnh 3600 s không có giá; `?sort=` không đi qua cache HTML. Không có cơ chế invalidation chủ động ⇒ giá Admin sửa hiện trên Public trong ≤ ~45 s. Đã xác minh đọc-only: Hyperdrive `PUBLIC_DB` **tắt query cache**; trình duyệt `max-age=0, must-revalidate`; khoá cache HTML có thêm `production:<brands>` khi cờ bật (cờ tắt giữ nguyên khoá cũ) ⇒ bật/tắt cờ không phục vụ HTML của trạng thái kia.

**Fail-safe (đã kiểm với ACL thật):** thiếu cột/quyền (42703/42501/42P01) ⇒ chạy lại cùng câu không có cột canonical, SKU trong phạm vi hiện "Cần liên hệ xác nhận giá", không 5xx, không legacy; dữ liệu không nhất quán ⇒ cùng nhãn. Cờ TẮT ⇒ câu lệnh/DTO không đổi.

**Tương thích rollback (hai rollback KHÁC NHAU, không đánh đồng):**
| Trạng thái | Kết quả |
|---|---|
| Worker mới, cờ TẮT, DB cũ (chưa 001) | OK — giống hiện tại |
| Worker mới, cờ BẬT, DB cũ/chưa có quyền | OK — fail-safe, mọi SKU in-scope "Cần liên hệ xác nhận giá" |
| Worker mới, cờ BẬT, DB đã 001+002+import | Giá canonical hiển thị |
| Worker CŨ (rollback Worker), DB đã import | OK — Worker cũ bỏ qua cột mới; Public quay lại không có giá |
| SQL 002 rollback khi Worker mới còn chạy, cờ BẬT | OK — fail-safe (đã test); nên tắt cờ trước |
| SQL 001 rollback | Chỉ khi đã xoá hết giá trị (`batch-*-rollback.sql`); sau đó Worker mới cờ TẮT/BẬT đều chạy (đã test) |
Rollback độc lập từng thành phần (Worker/cờ, dữ liệu, quyền cột, Edge Function không xoá được → thôi thấy cột qua P470-002 rollback, schema): xem `release-manifest.md` §5.

**Thứ tự cutover:** xem `release-manifest.md` §3–§5 (cổng phê duyệt A–E, trình tự thực thi, rollback độc lập). Tóm tắt: merge (quyền riêng) → backup/export (GO-B) → P470-001/002 (GO-C) → snapshot đọc-only + planner → import (GO-D, plan SHA pin trước apply) → Edge Function → lane M4 `publish canonical_pricing=off` → `on` (GO-E). **P470-003 hoãn** (manifest §6).

**Phát hiện độc lập (cần quyết định riêng):** với ACL thật của `dpg_public_catalogue` (thiếu `spec_definitions.key`, `spec_options.slug`) truy vấn sibling của `main` (#432) báo `permission denied` ⇒ PDP có `variant_group` sẽ 5xx nếu phát hành từ `main`. #476 làm "không có sibling" khi gặp 42501; muốn có bộ chọn biến thể thì cần grant #432 (Owner đã dặn không phát hành kèm #432). Đồng thời lọc khoảng giá (`price_min/max`) trên PLP vẫn trả rỗng như hiện nay.

## 7b. PASS / FAIL / UNKNOWN
| Hạng mục | Kết quả |
|---|---|
| Migration 001–003 + rollback trên PG local cô lập (baseline md5 khớp Production byte-exact) | PASS |
| Hành vi order/quote: giá canonical, voucher × qty đúng 1 lần, NULL→quote, nhóm khác legacy | PASS (local) |
| Planner: dry-run mặc định, guard identity/SHA/headroom/row-count, rollback batch, idempotent | PASS (local) |
| Admin API giữ status nhất quán (37/37 tích hợp + 5 unit) | PASS (local) |
| Admin API trên DB có cột status thật (sau 001) | UNKNOWN |
| CI `quality` #471/#472/#473/#474 | PASS (xanh trên đầu nhánh); #475 chưa kiểm |
| Snapshot projection + PDP/PLP/search/JSON-LD canonical (#475; đường rollback/Preview) | PASS (local), mặc định TẮT |
| Đường live PostgreSQL (Production thật), ACL/RLS thật, 7 pha tích hợp + 23 unit (#476) | PASS (local/CI) — chưa chạy trên DB/Worker thật (UNKNOWN) |
| Benchmark local: 1 câu lệnh/trang, cùng plan; PLP +~2 ms (ORDER BY CASE) | PASS (chỉ hình dạng plan, không phải latency live) |
| Variant siblings dưới ACL thật | FAIL trên `main` (5xx) → #476 degrade; grant #432 chưa quyết |
| `price_valid_until` thật của Hita / 28 WARN voucher lớn | UNKNOWN — cần crawl lại + Owner nhìn |
| 181 SKU active chưa xác minh | Codex tiếp tục; không chặn nếu Owner chấp nhận ẩn giá |
| Sao lưu (5.1, 5.2) | CHƯA TẠO |

## 8. Smoke sau deploy (khi được GO)
Public: PDP 3 SKU mẫu mỗi trạng thái (PRICE_VERIFIED có promo+voucher, CONTACT_VERIFIED, UNRESOLVED/NULL) hiển thị đúng; PLP sắp xếp giá; schema.org `Offer` chỉ khi có giá; không SKU sanitary nào hiện giá legacy. Admin: đăng nhập, sửa giá 1 SKU TEST-owned rồi hoàn tác (status chuyển PRICE_VERIFIED/NULL). Quote: tạo báo giá 1 SKU canonical + 1 SKU NULL (snapshot không dùng legacy). Order (nếu bật): voucher × qty đúng, replay idempotent. Theo dõi 24h: log lỗi `PRICE_*`, `check_violation`, dung lượng DB < 350 MiB, tỉ lệ 5xx/p95, số báo giá/đơn.

## 9. Owner GO phải nêu
Candidate SHA cuối · CSV sha256 · plan SHA · danh sách SQL (P470-001/002, batch; 003 hoãn) · rollback · headroom đo lại ngay trước GO · xác nhận sao lưu đã tạo · quyết định mục 7 · cửa sổ thực hiện. Sau đó mới dừng ở ngưỡng này; mọi thứ khác không được chạy.
