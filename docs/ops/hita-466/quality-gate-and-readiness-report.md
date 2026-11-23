# #466 — CSV Quality Gate (A) + Readiness Audit nhập giá Hita (B)

Không crawl, không ghi database (TEST/Production), không deploy, không importer mới, không migration. Production chỉ được `SELECT` chỉ đọc (project `bonxyxluzlxfkdetryoo`). Chưa phải GO nhập giá và chưa phải GO #449. Dữ liệu hợp lệ theo cổng **chưa** có nghĩa là Owner đã duyệt.

## Chạy lại bằng một lệnh
```
npx tsx scripts/hita-price-audit/quality-gate.mts <file.csv> \
  --inventory scripts/hita-price-audit/inventory/toto-active-prod-20261123.json \
  --inventory scripts/hita-price-audit/inventory/toto-inactive-prod-20261123.json \
  [--now <ISO UTC>] [--max-age-hours 24] [--label <nguồn>] [--issues-csv out.csv] [--json out.json]
```
Mã thoát `1` nếu file hoặc bất kỳ dòng nào có lỗi chặn. Dùng được cho snapshot mới của Codex mà không sửa mã. Chỉ đọc file, không mạng, không DB.

---
## A. CSV Quality Gate

**Snapshot đã audit:** nhánh `codex/448-toto-hita-review` tại `98e3101b9ab0c9fca9a84c260d3a923a67b10626` (2026-11-23 18:34:12 UTC), file `docs/ops/hita-448/toto/toto_prices_review.csv`, sha256 `b795853e7964…`. Dữ liệu Codex thay đổi sau SHA này **chưa được audit**. Không sửa CSV hay nhánh của Codex.

### Luật kiểm
- **FAIL (lỗi chặn, dòng không bao giờ được dùng):** thiếu/trùng cột; `dpg_id` sai/trùng; SKU rỗng/thừa khoảng trắng/trùng (không phân biệt hoa thường); `is_active` không phải true/false; `status`/`review_status` lạ; **dòng không phải EXACT mà có giá** (blank ≠ 0); giá không phải số nguyên dương (cấm 0, âm, `1.000.000`, `1e6`, số thập phân); thiếu giá gốc; **giá KM ≥ giá gốc**; **voucher ≥ giá bán** hoặc voucher không có điều kiện; `hita_exact_sku` thiếu/lệch SKU; URL không phải trang sản phẩm `https://hita.com.vn/…-<số>.html`; tiền tệ ≠ VND; thời điểm nguồn sai định dạng hoặc ở tương lai; ô bắt đầu bằng `= + - @`; lệch id/SKU/active so với inventory Production.
- **WARN (Owner xem, không tự loại):** giá hết hạn hoặc còn dưới 48 giờ; thiếu/sai `price_valid_until`; nguồn cũ hơn 24 giờ; điều kiện voucher không nêu "online"; chỉ khác hoa/thường ở SKU; nhiều SKU dùng chung một URL Hita (nghi lẫn anh em); giảm ≥ 50% và voucher ≥ 30% giá bán (cờ để xem, **không** phải ngưỡng loại).
- **Phân loại:** `ELIGIBLE_PRICED` (EXACT, nguồn mới, không FAIL), `ELIGIBLE_NO_PRICE` (CONTACT/DISCONTINUED/NOT_FOUND/AMBIGUOUS nguồn mới), `UNRESOLVED` (NOT_CRAWLED/BLOCKED/UNKNOWN hoặc nhãn pilot cũ), `INVALID` (có FAIL).

### Kết quả trên snapshot (4.441 dòng TOTO, đối chiếu inventory Production 2.057 active + 2.384 inactive)
| Nhóm | Số dòng |
|---|---:|
| **ELIGIBLE_PRICED** (đủ điều kiện xem xét) | **132** |
| ELIGIBLE_NO_PRICE (CONTACT 4 + DISCONTINUED 7) | 11 |
| UNRESOLVED (4.293 NOT_CRAWLED, 4 UNKNOWN, 1 AMBIGUOUS mang nhãn pilot cũ) | 4.298 |
| INVALID (lỗi chặn) | **0** |
| Dòng có cảnh báo | **0** |
| Trùng dpg_id / trùng SKU / lệch inventory | 0 / 0 / 0 |

Trong 132 dòng có giá: 132 có giá KM, 64 có voucher. Không có chênh lệch bất thường theo các cờ ở trên (giảm ≥ 50%: 0; voucher ≥ 30%: 0; URL dùng chung: 0). Hạn giá cùng là `2026-12-01`, còn trên 48 giờ tại lúc chạy.

**Kiểm chứng cổng không "mù":** chèn 8 lỗi có chủ đích vào bản sao tạm của snapshot thật (KM = giá gốc, giá 0, SKU Hita sai, URL ngoài Hita, SKU trùng, giá trên dòng CONTACT, giá hết hạn, giảm sâu). Cổng bắt được **cả 8** (7 dòng INVALID, cờ cảnh báo đúng). Bản sao đã xóa; không đụng file gốc. Unit test: 15 test cho cổng, tổng 56/56 trong `scripts/hita-price-audit`; `tsc` và `eslint` sạch.

**Lưu ý đúng phạm vi:** 143/4.441 dòng TOTO (3,2%) có kết quả, tương ứng 0,87% của 16.447 SKU ngành vệ sinh Production. "Đạt cổng" nghĩa là nhất quán nội bộ, đúng SKU và đúng định dạng; **không** chứng minh khớp giá đang hiển thị trên Hita (tôi không truy cập được Hita để kiểm độc lập).

---
## B. Readiness Audit (chỉ đọc)

### Đã xác minh bằng `SELECT` trên Production
| # | Phát hiện |
|---|---|
| V1 | `dpg_app.products` **chưa có** 3 cột `regular_price_vnd`, `promotional_price_vnd`, `online_voucher_amount_vnd`. Chỉ có giá cũ: `price`, `original_price`, `list_price`, `sale_price`, `online_discount_amount`, `price_display`, `price_state`, `price_source`, `price_confidence`, `price_updated_at`. |
| V2 | Có `UNIQUE (sku)` và khóa chính `id`, nên khóa nối chính xác id + SKU dùng được. **Không có** ràng buộc CHECK nào về giá. RLS bật và ép buộc. |
| V3 | Ngành vệ sinh 16.447 SKU (5.344 active). Giá cũ: 12.625 có `price > 0`, 1.389 có voucher cũ. Ba ngành còn lại 1.305 SKU giữ giá cũ. |
| V4 | Production **0 đơn hàng**. Bảng đơn **không có** `commercial_snapshot`, `order_origin`, `shipping_fee_status` (TEST có). Hàm đặt hàng là `public.runtime_order_create`, tính giá từ `list_price`/`sale_price` cũ (yêu cầu `list_price > 0` và còn hàng), **không có voucher**. Không có `guest_order_request_create`. |
| V5 | Trigger `leo538_free_tier_headroom` trên `products`: **chặn cứng khi database > 350 MiB**. Dung lượng hiện tại **279,7 MiB**, còn **70,3 MiB**. Bảng sản phẩm: heap 36 MB, 30 index (20 MB), toast 19 MB. |
| V6 | Quyền mức bảng: `dpg_migration` có UPDATE; `dpg_admin_api` và `dpg_public_catalogue` **không** có SELECT/UPDATE mức bảng (có thể có quyền mức cột/view: **chưa kiểm**). |

### Đã xác minh bằng mã nguồn
- Public chỉ đọc 3 cột canonical khi `APP_ENV=staging` **và** `PREVIEW_TEST_DATABASE_ISOLATED=true` (`live-public-catalogue.ts`). Trên Production, Public **bỏ qua** 3 cột này.
- Cổng `/api/orders` chỉ mở ở staging cô lập (`orderIntakeAllowed`); Production luôn `not-found`.
- Admin API/UI đã có kiểm tra giá (`canonical-pricing.ts`, `admin-api/resources.ts`), dò cột động nên chịu được DB thiếu cột. Migration 006–009 chỉ có cho TEST.

### Trả lời các câu hỏi
1. **Tiếp nhận CSV hiện tại được không?** *Về định dạng và khóa nối: được* (132 dòng có giá + 11 dòng không giá qua cổng). *Về hệ thống: chưa*, vì Production thiếu cột, ràng buộc, quyền ghi và logic đặt hàng canonical. Hiện CSV mới phủ 3,2% TOTO.
2. **Thiếu gì (blocker P0):**
   - **P0-1** DDL thêm 3 cột nullable + CHECK (số nguyên dương, KM < gốc, voucher < giá bán). Mẫu: `006_*.sql` (TEST), cần Owner duyệt riêng.
   - **P0-2** Quyền ghi cho vai trò Admin API trên 3 cột (mẫu `007`, tên vai trò Production khác TEST).
   - **P0-3** Hàm đặt hàng canonical + trừ voucher: không thể copy `008` vì schema đơn Production khác (V4). Cần chỉnh/bổ sung hàm và 3 cột đơn (snapshot) khớp Production.
   - **P0-4** Đổi cổng đọc giá của Public Worker từ "staging" sang "ngành vệ sinh" cho Production (mã + release #449, tách khỏi #432/#433/#440).
   - **P0-5** Không có cột lưu nguồn: `price_valid_until`, `voucher_condition`, URL Hita, thời điểm. Cần bảng/sổ cái riêng hoặc lưu CSV đã duyệt làm bằng chứng.
   - **P0-6** Dung lượng: còn 70,3 MiB so với ngưỡng chặn cứng (xem rủi ro bên dưới).
3. **Tác động:** *Nhập dữ liệu vào 3 cột không đổi gì hiển thị cho khách* cho đến khi Public Worker mới được release (V1 + cổng đọc). Khi release: PDP/listing hiển thị `KM ?? gốc`, SKU không giá hiện "Liên hệ báo giá" và xuống cuối khi sắp xếp giá; Admin hiện 3 ô giá; giỏ/đặt hàng chỉ có tác dụng khi hàm đặt hàng canonical được triển khai.
4. **Rủi ro:**
   - **Voucher trừ hai lần:** *không phát sinh chỉ do nhập dữ liệu*, vì hiện Production không có nơi dùng voucher (`runtime_order_create` không có voucher, cổng đơn đóng). Rủi ro chỉ xuất hiện khi bật giỏ + hàm đặt hàng; thiết kế "trừ một lần × số lượng ở giỏ, đơn lưu giảm giá một lần" đã được kiểm trên TEST (#446/#447) nhưng **chưa có trên Production**.
   - **Giá âm/bằng 0:** cổng CSV chặn (FAIL); DB Production **chưa có CHECK**, nên cần P0-1 làm lớp chặn thứ hai.
   - **Sai SKU:** khóa `id` + `UNIQUE(sku)`; importer phải nối theo cả `id` lẫn `sku`, dừng nếu lệch (cổng đã kiểm lệch inventory).
   - **Nhầm giá gốc/KM:** ba cột tách biệt, ánh xạ trực tiếp từ CSV; cổng chặn KM ≥ giá gốc. Không đụng `original_price`/`list_price`/`sale_price`.
   - **Dung lượng (ước tính, chưa đo):** cập nhật toàn bộ 16.447 hàng có thể tạo bản ghi cũ ở heap (~33 MB) và index (~19 MB, 30 index nếu không HOT) trước khi dọn → khoảng 50 MB so với còn 70 MiB. Quá sát; phải chia lô nhỏ, VACUUM giữa các lô, chốt dừng trước 320 MiB.
   - **Phạm vi nhầm:** `UPDATE` phải giới hạn đúng 16.447 SKU ngành vệ sinh; 1.305 SKU ngành khác không được thay đổi.

### Kế hoạch nhập an toàn đề xuất (chỉ đề xuất, chưa triển khai, cần Owner/Tech Lead duyệt ở #449)
1. **Điều kiện:** Owner duyệt tập CSV đã qua cổng (không FAIL, WARN đã xem); chốt SHA mã + SQL.
2. **Preflight chỉ đọc trên Production:** nối CSV với `products` theo `id`+`sku`: số dòng khớp 100%, `is_active` khớp, mọi dòng thuộc `thiet-bi-ve-sinh`, 3 cột canonical đang NULL; đo dung lượng và headroom.
3. **Diff trước/sau** xuất ra file (số hàng đổi, 3/2/1 mức, voucher, NULL); Owner xem.
4. **DDL riêng** (thêm cột + CHECK + quyền), thử trước trên TEST/bản sao; `ADD COLUMN` nullable không ghi đè bảng.
5. **Nhập theo lô** (khoảng 500 hàng): mỗi lô một transaction, `UPDATE … FROM VALUES` với điều kiện `id`+`sku` và giá trị trước đang NULL (idempotent), `GET DIAGNOSTICS` phải bằng số hàng của lô, ghi sổ cái (before/after), kiểm dung lượng, VACUUM giữa các lô, **dừng ngay khi lệch**.
6. **Rollback dữ liệu** độc lập với rollback Worker: đặt 3 cột về giá trị trước (NULL) theo sổ cái; rollback DDL theo file đảo ngược.
7. **Kiểm tối thiểu:** PDP mẫu 3/2/1 mức và SKU NULL; sắp xếp NULL cuối; Admin sửa giá; ngành khác không đổi (đếm trước/sau); khi bật giỏ: thêm vào giỏ trừ voucher đúng một lần, đơn lưu đúng.
8. **Thứ tự phát hành:** DDL + dữ liệu (không hiển thị) → Worker (chỉ ngành vệ sinh) → hàm đặt hàng canonical nếu bật giỏ.

### Giả định chưa kiểm chứng
- Quyền mức cột/view của `dpg_admin_api` và `dpg_public_catalogue` trên Production.
- Cấu hình biến môi trường của Worker Production (chỉ đọc từ mã, không đọc từ hạ tầng).
- Giỏ/checkout Production đang đóng: dựa trên mã và audit #444/#445; tôi không gọi thử Production.
- Ước tính dung lượng (không chạy thử cập nhật).
- Giá CSV khớp giá hiện tại trên Hita (không truy cập được Hita).
