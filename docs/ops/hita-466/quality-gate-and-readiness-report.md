# #466 — CSV Quality Gate (A) + Readiness Audit (B) — bản theo quy tắc giá Owner 24/11

Chỉ đọc: không crawl, không ghi database (TEST/Production), không deploy, không importer/migration/UPDATE/DELETE/DROP, không merge. Production chỉ được `SELECT` (project `bonxyxluzlxfkdetryoo`). Đây là định hướng cho release tương lai, **chưa phải GO** thay đổi Production, chưa phải GO #449. Dữ liệu "đã xác minh" bên dưới nghĩa là qua cổng kiểm của crawl, **chưa** có nghĩa Owner đã duyệt.

## 0. Quy tắc đã chốt (Owner) và phần còn chờ duyệt
**Đã chốt (nghiệp vụ):** giá hiện tại của DPG V1 là lỗi thời; Hita EXACT SKU đã xác minh là nguồn giá chuẩn mới cho ngành thiết bị vệ sinh; không dùng giá cũ để điền thiếu hay làm dự phòng; EXACT → 3 giá canonical; CONTACT → 3 giá NULL và hiển thị "Liên hệ báo giá"; NOT_FOUND → danh sách ứng viên xóa tương lai (không tự xóa); AMBIGUOUS giữ chưa xác minh; DISCONTINUED ghi nhận để Owner quyết; NOT_CRAWLED/BLOCKED/UNKNOWN chưa có kết luận.

**Đã chốt thêm (Owner, 24/11, khóa 5/5 tại [#466](https://github.com/tranhuunguyenhuy-hue/dongphugia-web/issues/466#issuecomment-7111910234)):** chính sách SKU chưa xác minh, NOT_FOUND, DISCONTINUED, sao lưu giá cũ ngoại tuyến và audit dung lượng chỉ đọc. Xem mục **B.7** (bảng quyết định + bước kỹ thuật). Việc Owner duyệt chính sách **không phải GO** merge PR này, nạp CSV, tạo 3 cột Production, xóa/NULL giá cũ, ẩn/xóa sản phẩm hay deploy.

**Còn chờ duyệt:** phạm vi phát hành chính xác và ngưỡng sẵn sàng của kế hoạch release (B.7, mục "Việc còn mở").

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

**Snapshot đã audit:** nhánh `codex/448-toto-hita-review` (PR #463) tại **`a361612a7cd49deeadccae37b623daaca5fe9126`** (2026-11-23 21:41:40 UTC), file `docs/ops/hita-448/toto/toto_prices_review.csv`, **sha256 `bda8301a86bc9f3d9c9ca01f7297c3183ee6efdcf82f1851b2757580d63ccf26`**, 4.441/4.441 SKU TOTO (2.057 active, 2.384 inactive). Dữ liệu Codex thay đổi sau SHA này **chưa audit**. Không sửa CSV/nhánh/PR của Codex. Các snapshot cũ (`98e3101`, `7f9ba89`, 731 SKU) **không** được dùng để nghiệm thu.

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

### Kết quả trên snapshot `a361612a` (chế độ `import-review`, đối chiếu inventory Production đủ 4.441 id/SKU)
Chạy lúc 2026-11-24 04:09 UTC. **0 lỗi chặn, 28 cảnh báo**; không trùng id/SKU, không lệch inventory (id, SKU, `is_active`).
| Nhóm | Tổng | Active (2.057) | Inactive (2.384) |
|---|---:|---:|---:|
| **PRICE_VERIFIED** (EXACT) | **2.469** | **1.543** (75,0%) | 926 |
| **CONTACT_VERIFIED** | **960** | 283 (13,8%) | 677 |
| **DISCONTINUED_REVIEW** | **307** | 49 | 258 |
| **AMBIGUOUS_UNVERIFIED** | **48** | 34 | 14 |
| **NOT_FOUND_CANDIDATE_DELETE** | **2** | 1 (id 2695) | 1 (id 35467) |
| UNRESOLVED (`UNKNOWN`) | **655** | 147 | 508 |
| INVALID | 0 | 0 | 0 |
Không còn dòng `NOT_CRAWLED`; mọi dòng ở trạng thái `FRESH_CRAWL_PENDING_OWNER_REVIEW`, nguồn `CODEX_CRAWL`, thời điểm nguồn 18:23–21:40 UTC ngày 23/11.

**Nhóm active (phạm vi đợt phát hành đề xuất đầu tiên, 2.057 SKU):** có kết luận cuối 1.876 (91,2%) = 1.543 có giá + 283 CONTACT + 49 DISCONTINUED + 1 NOT_FOUND; **chưa xác minh 181 (8,8%)** = 147 UNKNOWN + 34 AMBIGUOUS. Trong 1.543 EXACT active: **771 đủ 3 giá** (gốc + KM + voucher), 772 hai giá (gốc + KM), 0 chỉ giá gốc; 771 có voucher. **Không dùng giá của nhóm inactive làm nguồn cho phát hành active** (inactive: 926 EXACT, trong đó 3 có voucher).

**Cần Owner xem (cảnh báo/ngoại lệ, không phải lỗi):**
- **28 cảnh báo `LARGE_VOUCHER_REVIEW`** (tất cả thuộc nhóm active): voucher **31% đến 68%** giá bán, tập trung ở các họ `CS838*`, `CS735*`, `TBV10*`, `TBV09*`, `TBW13*`, `TBW10*`. Có thể là chương trình thật nhưng 68% là rất cao; cần duyệt từng dòng trước khi nạp.
- **Hạn giá:** cả 2.469 dòng EXACT cùng `price_valid_until = 2026-12-01`. Giá trị giống hệt nhau cho mọi SKU nên **nhiều khả năng là mặc định của trang Hita, không phải hạn thật của từng khuyến mãi** (suy luận, chưa kiểm chứng). Còn khoảng 7 ngày kể từ lúc chạy; cổng sẽ cảnh báo khi còn dưới 48 giờ. **Kế hoạch release phải crawl lại ngay trước cutover.**
- **NOT_FOUND (2):** id 2695 là SKU kết thúc bằng `/` (có thể bị cắt, **kiểm tra lại danh tính trước khi coi là ứng viên xóa**); id 35467 là SKU 13 ký tự, đang inactive. Cả hai chỉ vào danh sách rà soát, không xóa.
- **UNKNOWN (655):** 596 "giá không đủ bằng chứng hoặc mâu thuẫn" và **59 `INVALID_PDP_URL`** (trông như giới hạn của bộ đọc URL phía crawler, **chưa phải kết luận về giá**; cần Codex xem lại, tôi không sửa CSV). **AMBIGUOUS (48):** 47 "không có kết quả tìm đúng SKU" (không lấy giá SKU tương tự), 1 "SKU trên trang không khớp".
- Mọi kết quả crawler **chưa phải giá đã được Owner duyệt** và chưa được so với giá đang niêm yết trên Hita (tôi không truy cập được Hita).

Danh sách theo nhóm cho Owner xem (không phải lệnh xóa/ghi): `docs/ops/hita-466/lists/{contact_verified,not_found_candidates,discontinued_review,ambiguous_unverified}.csv`; tổng hợp: `quality-gate-summary.json` (kèm sha256 và thời điểm chạy).
- **Độ phủ:** TOTO 4.441/4.441 có kết quả crawler; toàn ngành vệ sinh Production 16.447 SKU thì mới **27,0% (4.441)** (active ngành vệ sinh 5.344, trong đó TOTO active 2.057 = 38,5%). Các thương hiệu khác chưa crawl.

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
1. **Dữ liệu đủ (đã chốt):** **không chuyển toàn bộ ngành sang giá mới trước khi hoàn thành lượt crawl các SKU active thuộc phạm vi phát hành** được xác định trong kế hoạch release; với TOTO active hiện còn 181/2.057 SKU (8,8%) chưa xác minh (147 UNKNOWN + 34 AMBIGUOUS) và chưa có phạm vi/ngưỡng nào được chốt. Owner phải duyệt tập CSV. Sau cutover, SKU chưa có dữ liệu chuẩn ẩn giá và hiển thị trạng thái cần liên hệ (B.7).
2. **DDL:** 3 cột nullable + CHECK (số nguyên dương, KM < gốc, voucher < giá bán) + quyền cho vai trò Admin (mẫu `006`/`007` ở TEST, tên vai trò Production khác).
3. **Nạp dữ liệu (chưa hiển thị):** vì Public Production bỏ qua 3 cột, bước này không đổi gì với khách.
4. **Mã:** Public/PDP/listing/sắp xếp (NULL cuối)/Admin/giỏ chỉ đọc canonical cho ngành vệ sinh (đổi cổng từ "staging" sang "ngành vệ sinh"); ngành khác giữ nguyên. Tách khỏi #432/#433/#440.
5. **Đơn hàng/báo giá:** viết lại `runtime_order_create`, `runtime_quote_create`, `runtime_quote_get` cho nhánh vệ sinh (chỉ giá canonical, voucher trừ một lần × số lượng, snapshot giá/giảm một lần), kèm cột snapshot còn thiếu ở Production. Chỉ cần nếu giỏ/đặt hàng Production được bật.
6. **Cutover + quan sát**, rồi mới xét dọn giá cũ (B.3).

### B.3 Kế hoạch loại bỏ giá/cột cũ (đề xuất)
- **Giai đoạn 1 (không mất dữ liệu):** ngừng đọc giá cũ cho ngành vệ sinh trong mọi bề mặt (V3) và hàm DB (V2); giữ cột và dữ liệu.
- **Giai đoạn 2 (sau quan sát, cần GO):** đặt giá cũ của **các SKU vệ sinh** về NULL. Không dùng làm kho dự phòng kinh doanh; chỉ giữ **một bản sao ngoại tuyến phục vụ rollback kỹ thuật, không dùng làm nguồn giá kinh doanh**, tối đa **7 ngày kể từ khi cutover được xác nhận ổn định** (đã chốt, B.7-4).
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

### B.7 Quyết định đã chốt và bước kỹ thuật tương ứng (chưa triển khai bước nào)
| # | Quyết định Owner (đã chốt) | Bước kỹ thuật cần có | Cần GO |
|---|---|---|---|
| 1 | Chỉ cutover sau khi crawl xong SKU active thuộc phạm vi phát hành. Sau cutover **không fallback giá cũ**; SKU chưa xác minh (NOT_CRAWLED/BLOCKED/UNKNOWN/AMBIGUOUS) **ẩn giá + hiển thị trạng thái cần liên hệ**, **không** biến thành CONTACT_VERIFIED. | (a) Chốt **phạm vi phát hành** và **ngưỡng sẵn sàng** trong kế hoạch release; cổng kiểm đã đo được độ phủ theo từng nhóm trên bất kỳ tập SKU nào. (b) Cần phân biệt được dữ liệu "Hita ghi liên hệ" với "chưa xác minh" dù cả 3 giá đều NULL → cần một trường trạng thái giá. Đề xuất xem xét dùng lại cột `price_state` sẵn có (giá trị hiện tại: priced/unknown/contact/discontinued/updating) **nhưng** các giá trị hiện tại đến từ nguồn cũ nên phải ghi lại cho SKU vệ sinh khi cutover; chưa chọn, cần review. (c) Public/PDP/listing/giỏ/báo giá: trạng thái "cần liên hệ" ẩn giá, không cho đặt hàng theo giá. | Owner GO riêng cho kế hoạch release/#449 |
| 2 | NOT_FOUND: giữ bản ghi, đưa vào danh sách rà soát xóa tương lai kèm chứng cứ; không tự xóa/ẩn/đổi trạng thái; sau cutover không hiển thị giá cũ. SKU id 2695 (dấu `/` cuối) cần kiểm tra lại danh tính. | Xuất `not_found_candidates.csv` (đã có, có thời điểm kiểm và URL tìm kiếm). Thêm bước **kiểm tra lại danh tính** trước khi một ứng viên vào danh sách xóa (so SKU DPG với nguồn hãng; riêng id 2695 phải xử lý trước). Không có lệnh DELETE nào trong phạm vi. | Owner GO riêng cho mọi thay đổi/xóa |
| 3 | DISCONTINUED: giữ bản ghi, phân loại rõ, không bán bằng giá cũ, không tự xóa. | `discontinued_review.csv` (đã có). Sau cutover: ẩn giá, trạng thái ngừng kinh doanh; cần Owner quyết định hiển thị chi tiết và vòng đời. | Owner GO riêng |
| 4 | Sao lưu giá cũ: **một bản sao ngoại tuyến** phục vụ rollback, không phải nguồn giá kinh doanh; giữ **7 ngày sau khi cutover được xác nhận ổn định**, rồi xóa theo quy trình có kiểm soát. Chưa tạo/xóa gì trong #466. | Định nghĩa nội dung bản sao: 6 cột giá cũ của SKU vệ sinh theo `id`+`sku` (dữ liệu giá cũ của ngành vệ sinh đo được khoảng 358 KiB) + checksum, lưu ngoài database, truy cập hạn chế; mốc "cutover ổn định" phải được ghi nhận bằng xác nhận cụ thể (ai, khi nào); quy trình xóa có kiểm soát sau 7 ngày. **Xung đột cần báo:** repo có sao lưu Production định kỳ (`m4-production-backup.yml`); các bản sao lưu hệ thống sẽ vẫn chứa giá cũ tới khi hết hạn lưu giữ theo chính sách đó. Chưa kiểm hạn lưu giữ; tôi không xóa hay can thiệp, chỉ báo để Tech Lead/Owner quyết định có coi là xung đột. | Owner GO khi tạo và khi xóa |
| 5 | Audit dung lượng Production **chỉ đọc**, để tìm cơ hội giảm dung lượng thực tế; phân biệt đo với ước tính; không suy đoán trùng lặp; không UPDATE/DELETE/DROP/VACUUM FULL hay đổi hạ tầng. | **Chưa chạy** audit riêng (báo cáo riêng, không thuộc PR này). Kế hoạch: với `products`, `product_spec_values`, `product_descriptions`, `product_images`, `m5_cdn_ledger`, `product_source_mappings`, `product_documents`: đo heap/index/toast, số hàng, dead tuple, kích thước theo cột bằng `pg_column_size` (đo), kiểm chứng trùng lặp bằng so khớp nội dung thật trước khi kết luận (không suy đoán), ghi rõ phần nào là đo và phần nào là ước tính. Số đo đã có ở B.4 là điểm khởi đầu. | Đã được Owner duyệt (chỉ đọc); chờ Tech Lead xếp lịch |

**Việc còn mở (chưa đặt chính sách):**
- **Phạm vi phát hành chính xác** (ví dụ chỉ TOTO active hay mọi thương hiệu active của ngành vệ sinh) và **ngưỡng sẵn sàng** (tỷ lệ SKU trong phạm vi có kết quả cuối) phải nêu rõ trong kế hoạch release. Số liệu để tham chiếu (snapshot `a361612a`): 5.344 SKU active ngành vệ sinh, trong đó **TOTO active 2.057** có 1.543 giá đã xác minh (75,0%), 283 CONTACT, 49 DISCONTINUED, 1 NOT_FOUND, **181 chưa xác minh (8,8%)**; các thương hiệu active còn lại (3.287 SKU) chưa crawl.
- Cách hiển thị chi tiết của từng trạng thái "cần liên hệ"/"ngừng kinh doanh" (nội dung chữ, nút) là quyết định giao diện, chưa chốt.

### B.8 Giả định chưa kiểm chứng
Quyền mức cột/view của `dpg_admin_api`/`dpg_public_catalogue`; biến môi trường Worker Production; giỏ/checkout Production đang đóng (dựa trên mã và audit #444–#445, tôi không gọi thử Production); ước tính tăng dung lượng khi nạp; việc `INVALID_PDP_URL` là giới hạn của parser; giá CSV khớp giá hiện tại trên Hita.
