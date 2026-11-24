# #470 — Commerce v1 (đặt hàng + báo giá mới) · gói phát hành MỘT LẦN cùng giá chính thức

**Trạng thái:** ứng viên kỹ thuật trên PR #479 (Draft). Chưa merge. **Không có hành động nào trên Production.** Staging TEST: DB đã chuẩn bị (synthetic); Worker Staging chưa deploy (xem §6).
Thay thế hoàn toàn luồng đặt hàng/báo giá cũ; **không** dùng lại bảng `dpg_app.orders/quote_*` hay RPC `runtime_*`. Phạm vi MVP: guest, giỏ → checkout → biên nhận, báo giá, giỏ hỗn hợp tách đơn/báo giá, hộp thư Admin (mới / đang xử lý / hoàn tất / huỷ). Không mở rộng PDP/listing/bộ lọc.

## 1. Hợp đồng nghiệp vụ (server quyết định)
| Quy tắc | Thực thi |
|---|---|
| Mua trực tiếp chỉ khi: SKU active + public, thiết bị vệ sinh, TOTO/INAX (slug), `sellable`, không ngừng kinh doanh, `canonical_price_status = PRICE_VERIFIED`, giá > 0, KM < giá gốc | `dpg_commerce.product_snapshot` (một định nghĩa duy nhất) |
| Mọi SKU khác (giá liên hệ, 599 chưa xác minh, 969 CONTACT, 315 DISCONTINUED, hãng/ngành khác) → **báo giá**, không bao giờ 0đ, không dùng giá legacy | `cart_check` / `quote_submit` |
| Client chỉ gửi `productId` + số lượng + tổng nó đã thấy; giá/voucher/tổng do DB tính; lệch tổng → `PRICE_CHANGED` (không ghi gì) để khách xác nhận lại | `order_submit` |
| Idempotency (sha256), rate-limit DB-side theo IP/điện thoại, snapshot dòng hàng bất biến, mã ngẫu nhiên `DH-`/`BG-` | schema + test |
| Khách không chạm bảng: Worker → login role → `SET ROLE dpg_commerce_intake` → 3 hàm SECURITY DEFINER; staff qua Admin API (cột giới hạn, máy trạng thái new→processing→done / cancelled, events append-only, RBAC + audit) | `001_commerce_schema.sql` |

## 2. Gói SQL (sha256) — theo thứ tự
| Bước | File | sha256 |
|---|---|---|
| C1 | `supabase/prod-prep/470/001_canonical_price_columns.sql` (+rollback) | `c08fcda9…27a1` / `8091c1e5…e520` |
| C2 | `002_canonical_price_grants.sql` (+rollback) | `a7560699…3a1a` / `d422a04d…508f` |
| C3 | **`004_commerce_direct_access_lock.sql`** (khoá `authenticated` ghi/execute đường cũ; giữ) (+rollback) | `029b3796…a291b3` / `ab80e082…cad9` |
| C4 | `supabase/commerce-v1/001_commerce_schema.sql` (`-v target=production -v admin_role=dpg_admin_api`) (+rollback) | `1fed3914…8315` / `f51d9dcc…3eca` |
| D | Import giá: planner theo hãng × trạng thái + lane ứng viên + lane trạng thái + **lane voucher** (gói #485 + `voucher-lane/`) | sha plan/batch ghi vào GO-D |
| F (sau ổn định, GO riêng) | `002_decommission_legacy.sql` (lưu trữ vào `dpg_legacy_commerce`) (+`002_decommission_legacy_restore.sql`) | `f0d57005…85e7` / `7a0ff593…7c41` |
| — | `003_runtime_order_quote_canonical.sql` | **đã thay thế** (đường RPC cũ bị khoá bởi 004 và lưu trữ bởi F) — không đưa vào release |

Bằng chứng local (PG thật, role thật): `prod-prep/470/tests/run-local.sh`, `import-local.sh`, `commerce-v1/tests/run-local.sh`, `run-decommission-local.sh` — **ALL PASS** (decommission restore khớp từng byte: hàng, md5 hàm, ACL).

## 3. Số liệu dữ liệu (thật, từ gói đã nghiệm thu)
4.648 giá (2.929 active / 1.719 inactive; 1.634 chỉ giá gốc + 3.014 gốc+KM) · voucher 1.101 (745 TOTO + 356 INAX) · 31 id giữ NULL (29 nghi vấn + 2 INAX khuyến mại giữ) · 1.284 dòng trạng thái (969 CONTACT + 315 DISCONTINUED) · 599 chưa xác minh = không giá (báo giá). Không refresh/theo dõi Hita; giá nghiệm thu là giá kinh doanh DPG.

## 4. Cờ & rollback (một bản phát hành)
| Thành phần | Tắt (mặc định) | Bật |
|---|---|---|
| Giá | `canonical_pricing=off` | `on` + `canonical_brands` |
| Đặt hàng/báo giá | `commerce=off` → API 404, UI ẩn, giỏ cũ không còn | `commerce=on` + `vars.V1_PUBLIC_COMMERCE_HYPERDRIVE_ID` (Hyperdrive riêng cho login role intake, **caching tắt**; không dùng lại `PUBLIC_DB`) |
Rollback: (1) Worker — `wrangler rollback` về version ghi trong GO-E (không hoàn tác SQL); (2) giá — rollback plan/batch theo ledger; (3) schema commerce — `001_commerce_schema_rollback.sql` (chỉ khi chưa có đơn thật; có đơn ⇒ export trước); (4) 004 — rollback khôi phục ACL baseline từng byte; (5) decommission — `002_..._restore.sql`.
Kiểm tự động trong lane: identity check từ chối `commerce=on` thiếu/trùng Hyperdrive, và kiểm binding thật của version sau deploy.

## 5. Cổng GO (Owner nêu giá trị trước khi hành động; **chưa cấp cổng nào**)
A merge #479 → B backup (`m4-production-backup`) → C1…C4 (**C3 = 004 có thể áp riêng/sớm: đóng đường bypass hiện đang mở, mà không cần phần còn lại**) → D import (từng plan) → E phát hành: function (admin-api mới) → Worker `commerce=off, canonical_pricing=off` verify → `publish` bật cả hai → smoke → giám sát → F decommission (GO riêng).
**Rủi ro tồn tại cho tới khi áp 004:** `authenticated` (đăng ký tự do đang bật; 0 tài khoản/0 đơn) vẫn gọi được RPC/ghi bảng đơn cũ. Gói vá sớm = 004 + backup, đã test, chưa áp.

## 6. Staging TEST (ref `uybumsnyqpwcidjxmfsv`) — đã làm / còn chặn
Đã (synthetic, TEST contract kiểm trước): `commerce_v1_test_price_status_prep_470` (thêm `canonical_price_status`/`checked_at`, đánh dấu PRICE_VERIFIED cho các dòng giá synthetic), `commerce_v1_001_schema_test_470` (schema `dpg_commerce`, 3 hàm, RLS, quyền Admin test, thêm membership `dpg_commerce_intake → dpg_order_intake_login`). Kiểm: `cart_check` trên TEST qua role intake → SKU TOTO 207 `order` (2×, voucher trừ đúng), GROHE 1289 `quote`, id lạ `unavailable`; operator không có membership bị `permission denied` (fail-closed).
**Chặn:** lane Staging `v1-fixed-preview.yml` (`prepare-m3`/`publish-m3`) chỉ chạy từ `main`, actor Owner, `approved_source_sha == github.sha`. Cần Owner cấp quyền merge #479 (cổng A) rồi chạy lane; đồng thời Owner cần secret/Hyperdrive intake TEST (`0f615c39…`) đã có trong environment. Cấu hình TEST preview đã tự thêm `PUBLIC_COMMERCE=on` khi có binding intake.

## 7. Checklist UAT cho Owner (Staging, dữ liệu synthetic)
1. PDP TOTO/INAX có giá: hiện giá gốc/giá bán/voucher đúng; nút **Thêm vào giỏ**. SKU giá liên hệ/ngừng: **Yêu cầu báo giá**.
2. Giỏ hỗn hợp: dòng mua được và dòng báo giá tách rõ; tổng + voucher khớp PDP.
3. Checkout đơn: thiếu/ sai SĐT, địa chỉ → báo lỗi; gửi thành công → trang biên nhận có mã `DH-…`; gửi lại (F5/bấm đúp) không tạo đơn thứ hai.
4. Báo giá: SĐT bắt buộc, không địa chỉ; mã `BG-…`.
5. Đổi giá trong Admin trước khi gửi → hệ thống báo **giá thay đổi**, yêu cầu xác nhận lại.
6. Admin → Bán hàng: thấy đơn/báo giá mới; chuyển trạng thái mới→đang xử lý→hoàn tất / huỷ; chuyển ngược bị chặn; ghi chú nội bộ; sale chỉ thấy đơn của mình.
7. `/api/orders` cũ, `/admin` cũ: không còn; trang giỏ cũ không còn.
8. Không có dữ liệu cá nhân trong URL/log; biên nhận không phải thanh toán/giữ hàng.
