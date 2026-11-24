# #470 — RELEASE MANIFEST (ứng viên kỹ thuật, chưa phê duyệt, chưa merge)

**Trạng thái:** candidate = PR #479 (Draft). Chưa merge, chưa có GO hosted nào. Mọi thao tác hosted chỉ được làm sau **GO riêng của Owner nêu đúng giá trị bên dưới, TRƯỚC khi hành động**. "Release binding" in ra từ script chỉ là định danh, không thay quyền Owner.

Quy ước tên: SQL của #470 gọi là **P470-001/002/003** (tên file `001/002/003_*` trong `supabase/prod-prep/470/`). Chúng KHÁC migration M4 cũ `supabase/m4-production/001/002` (đã áp dụng trên Production từ trước: Admin function v2 đang chạy, `production_writes_allowed=true`).

## 1. Định danh
| Mục | Giá trị |
|---|---|
| Target | Supabase Production `bonxyxluzlxfkdetryoo` (`target_contract`: project `dongphugia-runtime`, region `ap-southeast-1`, environment `preview`, ceiling 367001600) · Cloudflare `d54f3402b9d112ab64d6135e0e3f1fb1`, Worker `dongphugia-v1-public-production` |
| Live baseline (đọc-only 24/11) | Worker version `45c1e9e7-63a7-4695-b8ae-a671eb6dc1f5` = "M4 Admin release `e070986a19fd`" · Edge Function `admin-api` v2 · Hyperdrive `PUBLIC_DB` (`dpg_public_catalogue`, query cache tắt) |
| Candidate | PR #479, nhánh `claude/470-pricing-release-candidate`; SHA phát hành thật = SHA `main` **sau khi** Owner cấp quyền merge (ghi vào các GO) |
| Lane phát hành Worker | `.github/workflows/m4-production-admin-release.yml` (combined Public+Admin, PostgreSQL). Không dùng `v1-worker-release.yml` (Public-only, guard từ chối thay Worker có Admin) |
| Lane Edge Function | `.github/workflows/m4-production-function-deploy.yml` (`operation=deploy` cần `owner_flag_and_migrations_confirmed=true` = **migration M4 cũ** + target flag, hiện đã đúng; không liên quan P470) |
| Lane backup | `.github/workflows/m4-production-backup.yml` (đã chạy hằng ngày 02:41 VN; lần gần nhất thành công 24/11 04:26 UTC, run 45326372117) |
| CSV | hiện `docs/ops/hita-448/toto/toto_prices_review.csv` @ `a361612a` sha256 `bda8301a86bc9f3d9c9ca01f7297c3183ee6efdcf82f1851b2757580d63ccf26` — **phải thay bằng CSV crawl lại gần cutover** (hạn 2026-12-01 đồng loạt) + Quality Gate `import-review` |
| Plan | chỉ tạo được SAU P470-001/002 (cần snapshot đọc-only có cột mới); basis gồm version + checked_at nên plan SHA đổi khi DB đổi |

## 2. SQL + rollback (sha256, bất biến từ `465ba5b`)
| File | sha256 |
|---|---|
| P470-001 `001_canonical_price_columns.sql` | `9b5237b04f8780256626ca559ef2e660e5cb8efc3cb31fd21dd119380284d189` |
| P470-001 rollback | `8091c1e559d510fcf87a2f4af79f8f7517849253c43bdbd8f32f9cc335e7e520` |
| P470-002 `002_canonical_price_grants.sql` | `a7560699fa3d0f550664a4a3693619fb56dded0a9a6ec6a15e6036e47ae63a1a` |
| P470-002 rollback | `d422a04d0e4fcc0ac46e7277068b960218bfa7a19fe5a4cc28a1b7bcb819508f` |
| P470-003 `003_runtime_order_quote_canonical.sql` — **HOÃN, không thuộc release** (§6) | `b2785499bcca4ef274d1855981e2383a38d988790a09dbecb179e3bc6f065891` |
| P470-003 rollback (draft) | `25f86bc96e66d698eab345191e7f34b40f69218b5476ca1bdf4e842468a56bcb` |
| `batch-NNNN-apply/rollback.sql`, `ledger.jsonl` | sinh sau schema, sha256 ghi vào GO-D |

## 3. Cổng phê duyệt (mỗi cổng = một hành động hosted thật; không có xác nhận "routine")
| Cổng | Ai/khi nào | Mở khoá | Nêu rõ trong GO |
|---|---|---|---|
| **A. Merge** | TL review xong → Owner cấp quyền merge (chưa cấp) | merge #479 vào `main` → SHA `S` + CI xanh | S |
| **B. Backup/export** | Owner, sau A | chạy `m4-production-backup` `operation=backup` ngay trước thay đổi + export đọc-only giá legacy sanitary (checksum, xoá 7 ngày sau cutover ổn định) | S, nơi lưu, retention |
| **C. Schema** | Owner, sau B | P470-001 rồi P470-002 (operator `postgres`) | S, sha256 §2, rollback sha, headroom đo lại |
| **D. Import** | Owner, sau C | snapshot **đọc-only** → planner dry-run (CSV mới + Gate) → *plan SHA + sha256 batch/rollback ghi vào GO trước khi apply* → apply từng batch | CSV sha, plan SHA, sha256 batch, headroom, danh sách 28 WARN đã xem, 181 SKU chưa xác minh được chấp nhận ẩn giá |
| **E. Phát hành** | Owner, sau D | function deploy → Worker `verify` → `publish canonical_pricing=off` → `publish canonical_pricing=on` | S, `rollback_version_id` Worker đang chạy, cửa sổ + người giám sát |

Gate tại dòng workflow: cả hai lane chạy trên `main` + actor Owner + `approved_source_sha == github.sha`; nên không thể phát hành trước A.

## 4. Trình tự thực thi (sau A và B)
1. **Preflight đọc-only:** target contract, md5 hàm baseline, `pg_database_size`, Worker version đang chạy khớp `rollback_version_id`, backup mới nhất thành công.
2. **C:** P470-001 → kiểm CHECK/cột → P470-002 → kiểm ACL (public đọc 4 cột, không `checked_at`/legacy).
3. **D:** snapshot đọc-only (`prod-import.mts --print-snapshot-sql`) → planner → GO-D → batch 1…N, mỗi batch kiểm row-count → đối soát đếm theo status, CHECK, headroom.
4. **E1 – Edge Function** (`m4-production-function-deploy`, `deploy`): tương thích mọi trạng thái schema — function mới chỉ dùng cột canonical khi `information_schema.columns` (chỉ liệt kê cột role API được truy cập) thấy chúng; trước P470-002 nó chạy y như cũ; function cũ (v2) không biết các cột này nên không bao giờ ghi chúng. Vì vậy **không có ràng buộc thứ tự cứng** giữa function và P470-001/002; đề xuất sau D để mọi chỉnh sửa giá của Admin về sau luôn qua hook mới. Một chỉnh sửa Admin xảy ra sau snapshot sẽ bị planner/batch bỏ qua (basis version + checked_at).
5. **E2 – Worker:** `m4-production-admin-release` `verify` (cờ off) → `publish canonical_pricing=off` (code mới, Public như cũ) → smoke → `publish canonical_pricing=on` (cùng SHA; khoá cache đổi nên không phục vụ HTML cũ) → smoke + giám sát 24 h.

## 5. Rollback độc lập (không đánh đồng)
| Thành phần | Cách | Ghi chú |
|---|---|---|
| Hiển thị giá | lane M4 `publish canonical_pricing=off` (hoặc `wrangler rollback <version>`) | nhanh nhất, không đụng DB |
| Dữ liệu import | `batch-NNNN-rollback.sql` (ngược thứ tự); từ chối dòng chưa apply/đã bị sửa | version chỉ tăng |
| Edge Function | **không xoá** (`functions delete` làm Admin ngừng) và không thể deploy SHA cũ (lane chỉ cho `main` HEAD). Đưa về hành vi cũ bằng **P470-002 rollback**: function tự thôi thấy cột trong ≤ 60 s | độc lập với Worker |
| Quyền cột | P470-002 rollback | Public/Admin tự fail-safe (đã test) |
| Schema | P470-001 rollback (chỉ khi đã xoá hết giá trị) | |
Thứ tự gợi ý khi lỗi hiển thị: cờ off → (nếu cần) batch rollback → P470-002 rollback → P470-001 rollback.

## 6. P470-003 (hàm order/quote) — HOÃN
Không chứng minh được cần cho đợt giá-only: Production hiện có **0 đơn, 0 báo giá, 0 người dùng `auth.users`**; không Edge Function thương mại nào được deploy (chỉ `admin-api`); `/api/orders` và `/gio-hang` đóng ở Production (test `worker-api-policy`, `gio-hang/page.test`); chỉ role `authenticated` có EXECUTE `runtime_order_create` và chưa có tài khoản nào. **UNKNOWN:** trạng thái đăng ký Supabase Auth (không đọc được qua SQL). Rủi ro còn lại nếu hoãn: người tự đăng ký được tài khoản có thể gọi RPC và nhận giá legacy; không có consumer hợp lệ. File giữ làm draft; không nằm trong cổng C. Đề xuất TL xác nhận Auth signup đang tắt (đọc-only) thay vì đưa 003 vào release.

## 7. Audit runtime ngoài giá: candidate vs live `e070986a` (110 file; chỉ các phần có tác động runtime)
| Khu vực (nguồn) | Hành vi Production trên candidate | Gate / bằng chứng |
|---|---|---|
| Giá canonical live-read (#470) | **OFF** mặc định | `PUBLIC_CANONICAL_PRICING` chỉ ghi qua lane M4 (`canonical_pricing`); test cờ OFF = câu lệnh không đổi |
| Series filter + bộ chọn biến thể (#432/#433/#440) | **OFF**: không query sibling/series, `?dong=`/`series_slugs` bị bỏ qua, listing không chạm bảng spec, UI không có gì để render | gate `seriesVariantEnabled()` (`APP_ENV!==production` hoặc `PUBLIC_SERIES_VARIANT=on`); test `series-variant-gate.test.ts` + PG ACL **có và không có** quyền series. **Khác live:** chip biến thể legacy trên PDP không còn (live từng hiển thị) |
| Giỏ hàng / checkout / order Public (#446) | **Đóng**: `/gio-hang` 404, `POST /api/orders` `not-found`, không có binding `ORDER_INTAKE_DB` trong config Production | `worker-api-policy.test`, `worker-policy.test`, `gio-hang/page.test` |
| Sort giá + control (#447) | chỉ khi giá canonical ON và chỉ danh mục vệ sinh; còn lại như live | `listing-query` + PG test |
| Admin giá canonical (#446/#473) | **Hoạt động sau P470-002** (trước đó fail-safe như live): form sản phẩm vệ sinh dùng 3 trường canonical (mọi hãng; chỉ TOTO hiển thị Public), trường giá legacy bị ẩn cho danh mục này | `externalGrant` + probe 60 s; test Admin API thật trên PG |
| Khoá cache HTML | thêm biến thể giá khi cờ ON; OFF = khoá cũ | `page-cache.test` |
| Nhãn truy vấn `public-db` | chỉ thêm nhãn | — |
| Công cụ Hita/CSV/crawl, docs, retire workflow, identity allowlist | không chạy trong Worker | không ảnh hưởng runtime |
Không thay đổi: SKU/URL, ngành/hãng ngoài phạm vi, Blog, media, auth Admin, SEO ngoài `Offer` canonical (JSON-LD chỉ khi có giá).

## 8. Bằng chứng (local/CI; không phải PASS Production)
Xem bình luận báo cáo trong #470: lint, typecheck, vitest toàn repo, `run-local.sh` + `import-local.sh`, tích hợp PG 10 pha với ACL/RLS thật (gồm gate series OFF khi quyền series tồn tại), build combined Public+Admin off/on + `wrangler deploy --dry-run`, CI trên đúng head #479. **UNKNOWN:** Worker local (`wrangler dev --remote`) cho cache/Hyperdrive thật, hành vi trên Production thật, đăng ký Supabase Auth.
