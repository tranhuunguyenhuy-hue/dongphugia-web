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
| 3 | Hàm order/quote sanitary-only (guard md5 baseline) | `003_runtime_order_quote_canonical.sql` | `003_…_rollback.sql` (khôi phục baseline, kiểm md5) |
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

## 7. KIẾN TRÚC GIÁ PUBLIC — Owner chọn A (24/11) nhưng có SỰ THẬT MỚI cần xác nhận lại
**Đính chính báo cáo trước:** câu "Public Production cứng `price: null`" chỉ đúng với builder M2 (`m2-public-snapshot.mts`, dùng cho Preview). Pipeline snapshot thật (`scripts/catalogue-direct/`) vốn đã hiển thị **giá legacy khôi phục** (quyết định PM 03/11, `public-restored-pricing.mjs`).

**Đọc-only Cloudflare (24/11, Worker `dongphugia-v1-public-production`):** Production **đang chạy `PUBLIC_CATALOGUE_SOURCE=postgresql` với binding Hyperdrive `PUBLIC_DB`** (đọc DB sống bằng role `dpg_public_catalogue`, không phải snapshot tĩnh); `v1-worker-release.yml` chỉ cho phép xuất bản bản PostgreSQL, snapshot là chế độ rollback. Vì role này không đọc được bất kỳ cột giá legacy, **hiện nay Public Production không hiển thị giá nào** (mapper `live-public-catalogue.ts` chỉ nạp giá khi `APP_ENV=staging` + TEST). Tiền đề "đọc snapshot tĩnh" của quyết định A do đó **chưa đúng với thực tế deploy**.

Đã làm theo A (đúng cho đường snapshot/rollback và Preview): PR **#475** — `public-canonical-pricing.mjs` + projection (scope sanitary × brand `toto`, mặc định TẮT, buộc CSV/plan SHA vào manifest, build dừng nếu `canonical_price_checked_at` quá hạn), hợp đồng listing, PDP/PLP/search, JSON-LD (Offer chỉ khi có giá, không khai availability), CTA giỏ hàng tắt (`cartEnabled=false`). Đường **live PostgreSQL** (đang là Production thật) chưa được đụng: cần mở rộng `live-public-catalogue.ts` (SELECT thêm 4 cột + `canonical_price_status`, cùng DTO `hita-exact-v1`) và đã có sẵn grants ở 002. Không làm trước khi Owner/TL xác nhận lại hướng.

**Thứ tự cutover (áp dụng cho cả hai đường):** 1 preflight + sao lưu (mục 5) + đo headroom → 2 001 → 002 → (kiểm CHECK/ACL) → 3 crawl lại + Gate + plan SHA mới → 4 import 10 batch + đối soát theo status → 5 003 (hàm order/quote) → 6 build artifact từ **đúng** candidate SHA + CSV sha + plan SHA (snapshot: `PUBLIC_CANONICAL_PRICING=on` + hai SHA bắt buộc, manifest ghi lại; live: cờ tương đương) → 7 kiểm file/preview cô lập (`preview2-candidate-audit`, smoke contract) → 8 publish bằng Owner GO riêng → 9 smoke + giám sát 24h → rollback. Rollback phải **đồng bộ**: chỉ rollback Worker hoặc chỉ rollback SQL đều không đủ — nếu Worker cũ chạy trên DB đã import thì giá canonical vô hại (cột bị bỏ qua) nhưng nếu SQL bị rollback khi Worker mới còn chạy thì mọi SKU in-scope thành "Cần liên hệ xác nhận giá"; vì vậy thứ tự rollback là Worker trước, SQL sau.

## 7b. PASS / FAIL / UNKNOWN
| Hạng mục | Kết quả |
|---|---|
| Migration 001–003 + rollback trên PG local cô lập (baseline md5 khớp Production byte-exact) | PASS |
| Hành vi order/quote: giá canonical, voucher × qty đúng 1 lần, NULL→quote, nhóm khác legacy | PASS (local) |
| Planner: dry-run mặc định, guard identity/SHA/headroom/row-count, rollback batch, idempotent | PASS (local) |
| Admin API giữ status nhất quán (37/37 tích hợp + 5 unit) | PASS (local) |
| Admin API trên DB có cột status thật (sau 001) | UNKNOWN |
| CI `quality` #471/#472/#473/#474 | PASS (xanh trên đầu nhánh); #475 chưa kiểm |
| Snapshot projection + PDP/PLP/search/JSON-LD canonical (PR #475; vitest 125 + 46 + 2 pass, tsc sạch) | PASS (local), mặc định TẮT |
| Đường live PostgreSQL (Production thật) dùng giá canonical | **CHƯA LÀM — chờ xác nhận hướng (mục 7)** |
| `price_valid_until` thật của Hita / 28 WARN voucher lớn | UNKNOWN — cần crawl lại + Owner nhìn |
| 181 SKU active chưa xác minh | Codex tiếp tục; không chặn nếu Owner chấp nhận ẩn giá |
| Sao lưu (5.1, 5.2) | CHƯA TẠO |

## 8. Smoke sau deploy (khi được GO)
Public: PDP 3 SKU mẫu mỗi trạng thái (PRICE_VERIFIED có promo+voucher, CONTACT_VERIFIED, UNRESOLVED/NULL) hiển thị đúng; PLP sắp xếp giá; schema.org `Offer` chỉ khi có giá; không SKU sanitary nào hiện giá legacy. Admin: đăng nhập, sửa giá 1 SKU TEST-owned rồi hoàn tác (status chuyển PRICE_VERIFIED/NULL). Quote: tạo báo giá 1 SKU canonical + 1 SKU NULL (snapshot không dùng legacy). Order (nếu bật): voucher × qty đúng, replay idempotent. Theo dõi 24h: log lỗi `PRICE_*`, `check_violation`, dung lượng DB < 350 MiB, tỉ lệ 5xx/p95, số báo giá/đơn.

## 9. Owner GO phải nêu
Candidate SHA cuối · CSV sha256 · plan SHA · danh sách SQL (001–003, batch) · rollback · headroom đo lại ngay trước GO · xác nhận sao lưu đã tạo · quyết định mục 7 · cửa sổ thực hiện. Sau đó mới dừng ở ngưỡng này; mọi thứ khác không được chạy.
