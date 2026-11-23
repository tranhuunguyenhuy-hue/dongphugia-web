# #466 — CSV Quality Gate (A) + Readiness Audit (B) — bản theo quy tắc giá Owner 24/11

Chỉ đọc: không crawl, không ghi database (TEST/Production), không deploy, không importer/migration/UPDATE/DELETE/DROP, không merge. Production chỉ được `SELECT` (project `bonxyxluzlxfkdetryoo`). Đây là định hướng cho release tương lai, **chưa phải GO** thay đổi Production, chưa phải GO #449. Dữ liệu "đã xác minh" bên dưới nghĩa là qua cổng kiểm của crawl, **chưa** có nghĩa Owner đã duyệt.

## 0. Quy tắc đã chốt (Owner) và phần còn chờ duyệt
**Đã chốt (nghiệp vụ):** giá hiện tại của DPG V1 là lỗi thời; Hita EXACT SKU đã xác minh là nguồn giá chuẩn mới cho ngành thiết bị vệ sinh; không dùng giá cũ để điền thiếu hay làm dự phòng; EXACT → 3 giá canonical; CONTACT → 3 giá NULL và hiển thị "Liên hệ báo giá"; NOT_FOUND → danh sách ứng viên xóa tương lai (không tự xóa); AMBIGUOUS giữ chưa xác minh; DISCONTINUED ghi nhận để Owner quyết; NOT_CRAWLED/BLOCKED/UNKNOWN chưa có kết luận.

**Chưa chốt (cần Owner/Tech Lead):** xem mục B.7. Điều quan trọng nhất: khi chuyển hệ thống sang giá mới, SKU chưa được crawl/chưa xác minh sẽ hiển thị gì.

## Chạy lại bằng một lệnh
```
npx tsx scripts/hita-price-audit/quality-gate.mts <file.csv> --mode import-review \
  --inventory scripts/hita-price-audit/inventory/toto-active-prod-20261123.json \
  --inventory scripts/hita-price-audit/inventory/toto-inactive-prod-20261123.json \
  [--export-dir <thư mục>] [--now <ISO UTC>] [--max-age-hours 24] [--label <nguồn>] [--issues-csv f.csv] [--json f.json]
```
`--mode import-review` **bắt buộc có inventory Production** (thiếu thì thoát mã 2). Mã thoát 1 nếu file hoặc dòng nào có lỗi chặn. Chỉ đọc file: không mạng, không DB.

---
## A. CSV Quality Gate

**Snapshot đã audit:** nhánh `codex/448-toto-hita-review` tại **`7f9ba89c85176406043478f7f23403571b5f8ea1`** (2026-11-23 18:55:33 UTC), file `docs/ops/hita-448/toto/toto_prices_review.csv`. Dữ liệu Codex thay đổi sau SHA này **chưa audit**. Không sửa CSV/nhánh/PR của Codex. (Lần audit trước ở `98e3101` đã được thay thế bằng bản này.)

### Phân loại (CONTACT ≠ NOT_FOUND ≠ AMBIGUOUS)
| Nhóm | Điều kiện | Hành động tương lai (sau Owner GO) |
|---|---|---|
| `PRICE_VERIFIED` | EXACT, nguồn mới, không lỗi | 3 giá canonical (KM/voucher NULL nếu Hita không có) |
| `CONTACT_VERIFIED` | Hita ghi "Liên hệ báo giá", từ đúng trang SKU, 3 giá để trống | 3 giá NULL, Public hiển thị "Liên hệ báo giá"; giá DPG cũ **không** làm dự phòng |
| `NOT_FOUND_CANDIDATE_DELETE` | Không có đúng SKU trên Hita, có thời điểm kiểm | Danh sách **ứng viên xóa sau này**, chưa xóa/ẩn/đổi trạng thái gì |
| `DISCONTINUED_REVIEW` | Hita ngừng kinh doanh, từ đúng trang SKU | Owner quyết định vòng đời sản phẩm; không xóa, không dùng giá cũ |
| `AMBIGUOUS_UNVERIFIED` | Chưa chứng minh đúng SKU | Giữ nguyên để kiểm tra; không lấy giá SKU tương tự, không gán CONTACT, không vào danh sách xóa |
| `UNRESOLVED` | NOT_CRAWLED / BLOCKED / UNKNOWN / nhãn pilot cũ | Chưa có kết luận; không xóa/đổi gì |
| `INVALID` | có lỗi chặn | Không dùng được |

**Lỗi chặn (FAIL):** thiếu/trùng cột; **số ô khác số cột, ngoặc kép chưa đóng hoặc đặt sai chỗ**; `dpg_id` sai/trùng; SKU rỗng/thừa khoảng trắng/trùng (không phân biệt hoa thường); `is_active` sai; trạng thái lạ; **dòng không phải EXACT mà có giá** (blank ≠ 0; giá DPG cũ không được nằm trong dòng CONTACT); giá không phải số nguyên dương; thiếu giá gốc; KM ≥ gốc; voucher ≥ giá bán hoặc thiếu điều kiện; SKU Hita lệch SKU DPG; URL không phải trang sản phẩm Hita; tiền tệ ≠ VND; thời điểm sai/ở tương lai; kết quả CONTACT/DISCONTINUED không từ đúng trang SKU; NOT_FOUND/mọi kết quả không giá thiếu thời điểm kiểm; NOT_FOUND mà lại có SKU Hita; lệch id/SKU/active so với inventory Production; ô bắt đầu bằng `= + - @`.
**Cảnh báo (Owner xem, không tự loại):** giá hết hạn/còn dưới 48 giờ/thiếu hạn; nguồn cũ hơn 24 giờ; điều kiện voucher không nêu "online"; nhiều SKU dùng chung một URL; giảm ≥ 50% và voucher ≥ 30% giá bán (cờ để xem, không phải ngưỡng loại).

### Kết quả trên snapshot `7f9ba89` (4.441 dòng TOTO, đối chiếu inventory Production đủ 4.441)
| Nhóm | Số dòng |
|---|---:|
| **PRICE_VERIFIED** | **533** |
| **CONTACT_VERIFIED** | **52** |
| **DISCONTINUED_REVIEW** | **16** |
| **AMBIGUOUS_UNVERIFIED** | **32** |
| **NOT_FOUND_CANDIDATE_DELETE** | **1** |
| UNRESOLVED (3.710 NOT_CRAWLED + 97 UNKNOWN) | 3.807 |
| INVALID (lỗi chặn) | **0** |
| Dòng có cảnh báo | 7 (cùng loại `LARGE_VOUCHER_REVIEW`) |

- Trong 533 dòng có giá: 533 có giá KM, 207 có voucher, 0 chỉ có giá gốc. Thời điểm nguồn 18:23–18:54 UTC (trong 24 giờ lúc chạy). Không trùng id/SKU, không lệch inventory.
- **7 cảnh báo** (voucher 31–38% giá bán): `TCF24410AAA#NW1` và 6 SKU họ `CS735*/CS838*` (khoảng 34%). Cùng một họ sản phẩm nên có thể là chương trình thật, nhưng cần Owner xem.
- **Lưu ý cho Owner:** SKU NOT_FOUND duy nhất (`TBV11130A/…/TBN01002B/`, id 2695) **kết thúc bằng dấu `/`**; có thể là SKU DPG bị cắt chứ chưa chắc không có trên Hita. Chưa nên coi là ứng viên xóa khi chưa xem lại.
- Nhóm UNKNOWN (97): 60 "giá không đủ bằng chứng/mâu thuẫn", 37 `INVALID_PDP_URL` (trông như giới hạn của bộ parse URL, **không phải** kết luận về giá). Nhóm AMBIGUOUS (32): 31 "không có kết quả tìm đúng SKU" (có ứng viên gần giống, không được lấy giá), 1 "SKU trang không khớp".
- Danh sách theo nhóm cho Owner xem (không phải lệnh xóa): `docs/ops/hita-466/lists/{contact_verified,not_found_candidates,discontinued_review,ambiguous_unverified}.csv`; tổng hợp: `quality-gate-summary.json`.
- **Độ phủ:** 731 dòng có kết quả = 35,5% TOTO active (731/2.057), 16,5% toàn TOTO (731/4.441), **4,4% toàn ngành vệ sinh Production (731/16.447)**. Đây không phải kết quả toàn ngành.
- **Giới hạn:** "đạt cổng" = nhất quán, đúng SKU, đúng định dạng và đủ bằng chứng nội bộ; **không** chứng minh khớp giá đang niêm yết trên Hita lúc này (tôi không truy cập được Hita).

**Kiểm chứng:** 19 unit test của cổng (gồm 4 nhóm kết quả tách biệt, giá cũ trong CONTACT, NOT_FOUND mang SKU Hita, thiếu thời điểm, ô lệch số cột, ngoặc kép, danh sách xuất) và 60 test cả thư mục `hita-price-audit` đạt; `tsc`, `eslint` sạch. Lần chèn lỗi vào bản sao snapshot thật trước đó đã bắt đủ 8/8 lỗi.

---
## B. Readiness Audit — kế hoạch thay thế (không song song lâu dài)

**Đích đến:** ba giá canonical + trạng thái báo giá cho ngành thiết bị vệ sinh, **không fallback giá cũ** ở Public/PDP/listing/Admin/cart/checkout/order/quote.

### B.1 Đã xác minh (SELECT trên Production hoặc đọc mã)
| # | Phát hiện |
|---|---|
| V1 | `dpg_app.products` **chưa có** 3 cột canonical; chưa có CHECK về giá. Có `UNIQUE(sku)`, `PRIMARY KEY(id)`. Ngành vệ sinh 16.447 SKU (5.344 active); ba ngành khác 1.305 SKU còn dùng giá cũ. |
| V2 | **Phụ thuộc DB vào giá cũ:** 3 hàm `public.runtime_order_create`, `public.runtime_quote_create`, `public.runtime_quote_get`; 1 index `idx_products_sale_status (sale_status, price_state)`. Không có view/materialized view nào và không bảng nào khác chứa các cột giá cũ. |
| V3 | **Phụ thuộc mã vào giá cũ:** khoảng 30 file (`original_price`/`list_price`/`sale_price`/`online_discount_amount`/`price_display`) ở `apps/public/src/runtime` (6), `src/lib` (4+SEO), `src/components` (sản phẩm, trang chủ, danh mục, UI, admin), `src/app/admin` (sản phẩm, trình tạo báo giá), `src/app/api/{orders,search}`, `src/store` (giỏ), `supabase/functions/admin-api` (2). Public chỉ đọc 3 cột canonical khi `APP_ENV=staging` + `PREVIEW_TEST_DATABASE_ISOLATED=true`; Production bỏ qua. |
| V4 | Đơn hàng: Production có **0 đơn**; `order_items` **không có** `commercial_snapshot`, `orders` không có `order_origin`/`shipping_fee_status` (TEST có). `runtime_order_create` tính giá từ `list_price`/`sale_price` cũ, yêu cầu `list_price > 0` và còn hàng, **không có voucher**; không có `guest_order_request_create`. Không thể copy migration 008 của TEST. |
| V5 | Trigger `leo538_free_tier_headroom` trên `products` **chặn cứng ghi khi database > 350 MiB**. Hiện **279,7 MiB** (còn 70,3 MiB). Bảng `products` 74,8 MiB (heap 36 MB, 30 index 20 MB, toast 19 MB); 2.335 dead tuple trên 17.752 hàng. |
| V6 | Quyền mức bảng: `dpg_migration` có UPDATE; `dpg_admin_api`, `dpg_public_catalogue` không có SELECT/UPDATE mức bảng (quyền mức cột/view chưa kiểm). |

### B.2 Điều kiện chuyển hệ thống sang giá mới (thứ tự đề xuất, mỗi bước cần Owner GO)
1. **Dữ liệu đủ:** Owner duyệt CSV và quyết định chính sách cho SKU chưa xác minh (B.7). Không cutover khi phần lớn SKU còn UNRESOLVED nếu chính sách là "không fallback": các SKU đó sẽ hiển thị "Liên hệ báo giá".
2. **DDL:** 3 cột nullable + CHECK (số nguyên dương, KM < gốc, voucher < giá bán) + quyền cho vai trò Admin (mẫu `006`/`007` ở TEST, tên vai trò Production khác).
3. **Nạp dữ liệu (chưa hiển thị):** vì Public Production bỏ qua 3 cột, bước này không đổi gì với khách.
4. **Mã:** Public/PDP/listing/sắp xếp (NULL cuối)/Admin/giỏ chỉ đọc canonical cho ngành vệ sinh (đổi cổng từ "staging" sang "ngành vệ sinh"); ngành khác giữ nguyên. Tách khỏi #432/#433/#440.
5. **Đơn hàng/báo giá:** viết lại `runtime_order_create`, `runtime_quote_create`, `runtime_quote_get` cho nhánh vệ sinh (chỉ giá canonical, voucher trừ một lần × số lượng, snapshot giá/giảm một lần), kèm cột snapshot còn thiếu ở Production. Chỉ cần nếu giỏ/đặt hàng Production được bật.
6. **Cutover + quan sát**, rồi mới xét dọn giá cũ (B.3).

### B.3 Kế hoạch loại bỏ giá/cột cũ (đề xuất)
- **Giai đoạn 1 (không mất dữ liệu):** ngừng đọc giá cũ cho ngành vệ sinh trong mọi bề mặt (V3) và hàm DB (V2); giữ cột và dữ liệu.
- **Giai đoạn 2 (sau quan sát, cần GO):** đặt giá cũ của **các SKU vệ sinh** về NULL. Không dùng làm kho dự phòng kinh doanh; chỉ giữ **một bản sao lưu ngoại tuyến** để khôi phục kỹ thuật khi rollback (Owner quyết định thời hạn giữ).
- **Giai đoạn 3:** `DROP COLUMN` các cột giá cũ **chỉ khi** không còn chức năng nào cần, kể cả ba ngành khác (1.305 SKU vẫn dùng). **Không DROP cột chung** cho đến quyết định riêng cho ngành khác.

### B.4 Về mục tiêu giảm dung lượng (đo, không giả định)
- Dữ liệu giá cũ của ngành vệ sinh (6 cột) chỉ tổng khoảng **358 KiB** (366.193 byte). Tức xóa/NULL/DROP giá cũ gần như **không giảm dung lượng đáng kể** (khoảng 0,4 MiB logic trên 279,7 MiB).
- `UPDATE … SET NULL` tạo bản ghi cũ, **tạm thời làm database lớn hơn** cho đến khi dọn; `VACUUM` thường **không trả dung lượng về hệ điều hành** (chỉ cho phép tái sử dụng chỗ trống); `DROP COLUMN` chỉ đổi metadata, không thu hồi chỗ. `VACUUM FULL`/ghi lại bảng `products` cần tới cỡ một bản sao bảng (khoảng 75 MiB) **lớn hơn mức còn trống 70,3 MiB**, có thể chạm ngưỡng chặn cứng: **không được làm khi chưa có phương án**.
- **Chỗ nặng thật (đo trên Production):** `products` 74,8 MiB, `product_spec_values` 40,7 MiB, `product_descriptions` 40,1 MiB, `product_images` 33,6 MiB, `m5_cdn_ledger` 24,0 MiB, `product_source_mappings` 18,0 MiB, `product_documents` 15,1 MiB. Trong `products`, `description` ≈ 14,2 MiB và `specs` ≈ 7,8 MiB. Muốn giảm dung lượng cần audit các bảng này riêng (chưa làm trong #466); không có kết luận về trùng lặp dữ liệu.
- Ảnh hưởng đến kế hoạch nạp: thêm cột nullable không ghi lại bảng; nạp 16.447 hàng có thể tạo thêm khoảng 50 MB trước khi dọn (**ước tính, chưa đo**) so với 70,3 MiB còn trống → chia lô nhỏ, kiểm dung lượng mỗi lô, dừng sớm.

### B.5 Trả lời các câu hỏi
- **Tiếp nhận CSV hiện tại được không?** Về định dạng và khóa nối (id + UNIQUE sku): **được**. Về hệ thống Production: **chưa** (thiếu cột, CHECK, quyền, mã đọc, hàm đặt hàng/báo giá; V1–V4).
- **Tác động bề mặt:** Public/PDP/listing chỉ đổi khi Worker mới được release; nạp dữ liệu một mình không đổi gì với khách (V3). Giỏ/đặt hàng/báo giá Production phụ thuộc giá cũ (V2, V4) và phải viết lại.
- **Rủi ro:** *Voucher trừ hai lần* không phát sinh từ việc nạp dữ liệu (Production chưa có nơi dùng voucher); chỉ khi bật giỏ + hàm đặt hàng canonical (đã kiểm trên TEST, chưa có trên Production). *Giá âm/0:* cổng CSV chặn, DB Production chưa có lớp chặn thứ hai (cần CHECK ở bước 2). *Sai SKU:* nối theo cả `id` và `sku`, dừng nếu lệch (chế độ duyệt nhập đã bắt buộc inventory). *Nhầm giá gốc/KM:* ba cột tách biệt, cổng chặn KM ≥ gốc. *Quá nhiều SKU thành "Liên hệ báo giá" khi cutover:* rủi ro nghiệp vụ lớn nhất (B.7).

### B.6 Kế hoạch nạp an toàn đề xuất (chỉ đề xuất, chưa triển khai)
Owner duyệt tập CSV đã qua cổng → preflight `SELECT` (nối id+sku 100%, 3 cột canonical đang NULL, đúng ngành, đo dung lượng) → diff trước/sau xuất file → DDL riêng → nạp lô nhỏ (khoảng 500 hàng), mỗi lô một transaction, idempotent (điều kiện giá trước = NULL), `GET DIAGNOSTICS` = số hàng của lô, sổ cái trước/sau, kiểm dung lượng, **dừng khi lệch** → CONTACT ghi 3 giá NULL kèm trạng thái "báo giá" → NOT_FOUND/DISCONTINUED/AMBIGUOUS/UNRESOLVED **không** UPDATE/DELETE/ẩn → rollback dữ liệu độc lập rollback Worker (đặt 3 cột về giá trước theo sổ cái) → kiểm tối thiểu (PDP mẫu 3/2/1 mức và CONTACT, sắp xếp NULL cuối, Admin sửa giá, ngành khác không đổi bằng đếm trước/sau, giỏ nếu bật: voucher trừ một lần) → release Worker sau khi dữ liệu đã có.

### B.7 Quyết định cần Owner/Tech Lead (chưa tự đặt chính sách)
1. Khi cutover, SKU **chưa crawl/BLOCKED/UNKNOWN/AMBIGUOUS** hiển thị gì: "Liên hệ báo giá", hay chờ crawl đủ rồi mới cutover? (Tôi không tự chọn.)
2. SKU **NOT_FOUND** trong lúc chờ quyết định xóa: hiển thị "Liên hệ báo giá" hay giữ như hiện tại?
3. **DISCONTINUED:** hiển thị gì và vòng đời tiếp theo.
4. Thời hạn giữ bản sao lưu ngoại tuyến của giá cũ (kỹ thuật, không phải dự phòng kinh doanh).
5. Audit dung lượng các bảng lớn (B.4) có làm riêng không.

### B.8 Giả định chưa kiểm chứng
Quyền mức cột/view của `dpg_admin_api`/`dpg_public_catalogue`; biến môi trường Worker Production; giỏ/checkout Production đang đóng (dựa trên mã và audit #444–#445, tôi không gọi thử Production); ước tính tăng dung lượng khi nạp; việc `INVALID_PDP_URL` là giới hạn của parser; giá CSV khớp giá hiện tại trên Hita.
