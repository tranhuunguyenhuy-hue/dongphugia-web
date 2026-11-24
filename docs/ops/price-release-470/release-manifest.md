# #470 — RELEASE MANIFEST (ứng viên kỹ thuật, chưa phê duyệt, chưa merge)

**Quyết định Owner 24/11 đã đưa vào candidate:** 1C (order/quote tương thích giá mới **và** khoá mọi đường tạo đơn/báo giá trực tiếp khi commerce OFF — P470-003 + P470-004), 2C (kích hoạt lại SKU luôn được phép; giá cũ quá 7 ngày bị ẩn bằng trạng thái `REVERIFY_REQUIRED`, giữ lịch sử), chấp nhận chip biến thể legacy (SKU, không xem trước giá/ảnh; #432/#433/#440 vẫn OFF), quy tắc giá ứng viên Owner-accepted (§9).

**Phạm vi đã duyệt (TL/Owner):** toàn bộ **6.531 SKU thiết bị vệ sinh TOTO + INAX**, gồm active và inactive — nhưng phát hành theo **từng hãng × từng trạng thái** (bảng §1b), mỗi đơn vị có gate/plan/ledger/rollback riêng và có thể phát hành độc lập.

**Trạng thái:** candidate = PR #479 (Draft). Chưa merge, chưa có GO hosted nào. Mọi thao tác hosted chỉ được làm sau **GO riêng của Owner nêu đúng giá trị bên dưới, TRƯỚC khi hành động**. "Release binding" in ra từ script chỉ là định danh, không thay quyền Owner.

Quy ước tên: SQL của #470 gọi là **P470-001/002/003/004** (tên file `001…004_*` trong `supabase/prod-prep/470/`). Chúng KHÁC migration M4 cũ `supabase/m4-production/001/002` (đã áp dụng trên Production từ trước: Admin function v2 đang chạy, `production_writes_allowed=true`).

## 1. Định danh
| Mục | Giá trị |
|---|---|
| Target | Supabase Production `bonxyxluzlxfkdetryoo` (`target_contract`: project `dongphugia-runtime`, region `ap-southeast-1`, environment `preview`, ceiling 367001600) · Cloudflare `d54f3402b9d112ab64d6135e0e3f1fb1`, Worker `dongphugia-v1-public-production` |
| Live baseline (đọc-only 24/11) | Worker version `45c1e9e7-63a7-4695-b8ae-a671eb6dc1f5` = "M4 Admin release `e070986a19fd`" · Edge Function `admin-api` v2 · Hyperdrive `PUBLIC_DB` (`dpg_public_catalogue`, query cache tắt) |
| Candidate | PR #479, nhánh `claude/470-pricing-release-candidate`; SHA phát hành thật = SHA `main` **sau khi** Owner cấp quyền merge (ghi vào các GO) |
| Lane phát hành Worker | `.github/workflows/m4-production-admin-release.yml` (combined Public+Admin, PostgreSQL). Không dùng `v1-worker-release.yml` (Public-only, guard từ chối thay Worker có Admin) |
| Lane Edge Function | `.github/workflows/m4-production-function-deploy.yml` (`operation=deploy` cần `owner_flag_and_migrations_confirmed=true` = **migration M4 cũ** + target flag, hiện đã đúng; không liên quan P470) |
| Lane backup | `.github/workflows/m4-production-backup.yml` (đã chạy hằng ngày 02:41 VN; lần gần nhất thành công 24/11 04:26 UTC, run 45326372117) |
| Gói dữ liệu Codex (offline, #481/#482 đã vào `main`) | 4 tập review + 4 tập ứng viên trong `docs/ops/hita-448/…` (bảng §1b/§9). sha256 CSV review hiện hành: TOTO active `858c9200…5a95`, TOTO inactive `d29a135d…24ff`, INAX active `9f1ed770…3869`, INAX inactive `58c1e47a…d6ac` — **chỉ để chứng minh planner nhận được; phải refresh gần cutover (hạn 24 h của Quality Gate, hạn Offer 2026-12-01) và pin lại CSV/plan SHA vào từng GO-D** |
| Plan | chỉ tạo được SAU P470-001/002 (cần snapshot đọc-only có cột mới); basis gồm version + checked_at nên plan SHA đổi khi DB đổi |

## 1b. Phạm vi 6.531 SKU và đơn vị phát hành (đọc-only Production 24/11; ID hãng bất biến, planner ghim cả id lẫn slug)
| Hãng (brand_id) | Active | Inactive | Tổng | Dữ liệu giá sẵn sàng import? |
|---|---|---|---|---|
| TOTO (1) | 2.057 | 2.384 | 4.441 | **Có**: active 1.543 giá + 283 liên hệ + 49 ngừng + 34 mơ hồ + 1 không thấy (147 chưa xác minh → trống); inactive 926 giá + 677 liên hệ + 258 ngừng + 14 + 1 (508 chưa xác minh). Gate FAIL=0; 28 WARN voucher (active) cần Owner xem |
| INAX (2) | 1.653 | 437 | 2.090 | **Có (phần đủ căn cứ)**: active 305 giá + 8 liên hệ + 8 ngừng + 2 + 10 (1.320 chưa xác minh/stale baseline → trống); inactive 8 giá + 1 liên hệ + 2 (426 chưa xác minh). Gate FAIL=0; 2 WARN giảm giá sâu. Phần còn lại dựa vào ứng viên (§9) hoặc refresh |
| Cộng | 3.710 | 2.821 | **6.531** | |

Mỗi (hãng × trạng thái) là **một plan riêng** (`prod-import.mts --brand toto|inax --state active|inactive`): CSV sha riêng, plan SHA riêng, ledger/checksum/rollback riêng, SQL ghim `brand_id`+`slug`, `category_id`, `is_active = <trạng thái>` và `sku`. Bộ planner **không bao giờ ghi `is_active`**: SKU đổi trạng thái giữa lúc lập plan và apply làm batch abort nguyên khối (test local). Giữ nguyên guard "chỉ active" toàn cục — plan inactive là tập được duyệt rõ ràng, không phải nới guard.

**Nhìn từ Public:** Public luôn chỉ đọc `is_active=true` → giá của SKU inactive (đã import) **không lộ** ở listing/search/PDP/SEO/sitemap (test PG pha 4c). Import inactive chỉ chuẩn bị dữ liệu; hiển thị chỉ xảy ra khi Admin bật lại SKU. Admin: bật lại SKU có giá canonical cần `canonical_price_checked_at` còn trong **7 ngày** (hằng `CANONICAL_REACTIVATION_MAX_AGE_MS`, *chính sách do Owner xác nhận*) hoặc phải xác minh lại giá; Admin không tự kích hoạt SKU nào.

**Có thể phát hành từng phần:** (1) TOTO active trước (`canonical_brands=toto`, mặc định); (2) thêm INAX khi dữ liệu đạt Gate (`canonical_brands=toto,inax`, chạy lại lane — cùng SHA); (3) các plan inactive độc lập, không ảnh hưởng Public. Không hãng nào bị kéo theo hãng kia.

**Cờ theo hãng (mặc định TẮT):** allowlist cứng TOTO/INAX ở 4 nơi, test khẳng định bằng nhau — lane M4 (`canonical_brands` ∈ `toto` | `inax` | `toto,inax`, mặc định `toto`), runtime Public (`canonicalProductionBrands()` = allowlist ∩ `PUBLIC_CANONICAL_PRICE_BRANDS`, thiếu biến → chỉ `toto`), khoá cache (chứa danh sách hãng), Admin SPA/Edge Function (`inCanonicalAdminScope`). Hãng ngoài allowlist/ngành khác: giữ hành vi legacy (Admin vẫn quản lý giá như hiện tại; trường canonical chỉ hiện cho vệ sinh × TOTO/INAX).

## 2. SQL + rollback (sha256 — pin lại ở head cuối; `002`, `001 rollback`, `003 rollback` không đổi từ `465ba5b`)
| File | sha256 |
|---|---|
| P470-001 `001_canonical_price_columns.sql` (CHECK có thêm `REVERIFY_REQUIRED`, 2C) | `c08fcda917884ada0ebbf7d1089ca427092e635f6a8e689297c7670b7b8827a1` |
| P470-001 rollback | `8091c1e559d510fcf87a2f4af79f8f7517849253c43bdbd8f32f9cc335e7e520` |
| P470-002 `002_canonical_price_grants.sql` | `a7560699fa3d0f550664a4a3693619fb56dded0a9a6ec6a15e6036e47ae63a1a` |
| P470-002 rollback | `d422a04d0e4fcc0ac46e7277068b960218bfa7a19fe5a4cc28a1b7bcb819508f` |
| P470-003 `003_runtime_order_quote_canonical.sql` — **thuộc release** (1C; nhánh canonical chỉ cho vệ sinh × TOTO/INAX id 1/2, hãng khác & ngành khác giữ legacy) | `90ab2ecdd310abcfe100e8a7401c2de3ff0ed940d0c826dec15ff23154abbfbf` |
| P470-003 rollback (khôi phục văn bản baseline, md5 kiểm) | `25f86bc96e66d698eab345191e7f34b40f69218b5476ca1bdf4e842468a56bcb` |
| P470-004 `004_commerce_direct_access_lock.sql` — **thuộc release** (1C: khoá bypass) | `029b37962ee3bbc885d1de0034590156b116b1b876ad96fce900c00242a291b3` |
| P470-004 rollback (khôi phục đúng ACL baseline từng byte) | `ab80e082e63ce2a9cc5175f3e813d513c22664f463e09ce923b5879c01d6cad9` |
| `batch-NNNN-apply/rollback.sql`, `ledger.jsonl` | sinh sau schema, sha256 ghi vào GO-D |

## 3. Cổng phê duyệt (mỗi cổng = một hành động hosted thật; không có xác nhận "routine")
| Cổng | Ai/khi nào | Mở khoá | Nêu rõ trong GO |
|---|---|---|---|
| **A. Merge** | TL review xong → Owner cấp quyền merge (chưa cấp) | merge #479 vào `main` → SHA `S` + CI xanh | S |
| **B. Backup/export** | Owner, sau A | chạy `m4-production-backup` `operation=backup` ngay trước thay đổi + export đọc-only giá legacy sanitary (checksum, xoá 7 ngày sau cutover ổn định) | S, nơi lưu, retention |
| **C. Schema + ACL** | Owner, sau B | P470-001 → P470-002 → P470-003 → P470-004 (operator `postgres`). **004 độc lập, có thể áp dụng riêng và sớm nhất** (đóng đường bypass đang mở ngay hôm nay mà không cần gì khác) | S, sha256 §2 (4 file + 4 rollback), headroom đo lại |
| **D. Import** (một GO cho mỗi plan: hãng × trạng thái; thêm một plan ứng viên riêng nếu Owner duyệt §9) | Owner, sau C | snapshot **đọc-only** → planner dry-run (CSV mới + Gate) → *plan SHA + sha256 batch/rollback ghi vào GO trước khi apply* → apply từng batch | CSV sha, plan SHA, sha256 batch, headroom, 28+2 WARN đã xem, SKU chưa xác minh chấp nhận ẩn giá; với ứng viên: file duyệt Owner (id + sha CSV + tham chiếu) |
| **E. Phát hành** (có thể làm 2 lần: `canonical_brands=toto`, sau đó `toto,inax`) | Owner, sau D của hãng tương ứng | function deploy → Worker `verify` → `publish canonical_pricing=off` → `publish canonical_pricing=on` | S, `canonical_brands`, `rollback_version_id` Worker đang chạy, cửa sổ + người giám sát |

Gate tại dòng workflow: cả hai lane chạy trên `main` + actor Owner + `approved_source_sha == github.sha`; nên không thể phát hành trước A.

## 4. Trình tự thực thi (sau A và B)
1. **Preflight đọc-only:** target contract, md5 hàm baseline, `pg_database_size`, Worker version đang chạy khớp `rollback_version_id`, backup mới nhất thành công.
2. **C:** P470-001 → kiểm CHECK/cột → P470-002 → kiểm ACL (public đọc 4 cột, không `checked_at`/legacy) → P470-003 (kiểm md5 hàm baseline trước, md5 mới sau) → P470-004 → **kiểm bằng `has_function_privilege`/`has_table_privilege` rằng `authenticated`/`anon`/`service_role` không còn đường ghi** (script tự dừng nếu còn).
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
| Order/quote | P470-003 rollback (khôi phục văn bản hàm baseline, kiểm md5; đơn đã tạo giữ nguyên) | độc lập với 004 |
| Khoá commerce | P470-004 rollback = cấp lại **đúng** ACL baseline (đã test so từng byte) — chỉ chạy khi Owner GO mở lại commerce | độc lập với 003 |
| Schema | P470-001 rollback (chỉ khi đã xoá hết giá trị, kể cả `REVERIFY_REQUIRED`) | |
Hai hãng: rollback batch/plan của INAX chỉ khôi phục đúng dòng INAX của plan đó (test local: INAX-active rollback giữ nguyên TOTO-inactive); `canonical_brands=toto` đưa INAX về legacy tức thì mà không đụng dữ liệu. Admin cũ (function v2) không biết cột canonical nên không bao giờ ghi chúng; chỉnh sửa Admin sau snapshot bị planner/batch bỏ qua (basis version + checked_at), và đổi `is_active` giữa plan và apply làm batch abort — đều có test local.
Thứ tự gợi ý khi lỗi hiển thị: cờ off → (nếu cần) batch rollback → P470-002 rollback → P470-001 rollback.

## 5b. Dung lượng cho 6.531 SKU (đo thật, đọc-only 24/11)
DB `293.328.563 B` (≈ 279,7 MiB) · trần trigger `367.001.600 B` (350 MiB) · headroom `73.673.037 B` ≈ **70,26 MiB**. Chi phí ước tính **2.115 B/dòng đổi** (bảo thủ, đã tính index/TOAST) → toàn bộ 6.531 dòng ≈ **13,17 MiB** (active 3.710 ≈ 7,48 MiB; inactive 2.821 ≈ 5,69 MiB; TOTO 4.441 ≈ 8,96 MiB; INAX 2.090 ≈ 4,22 MiB) → còn ≈ **57,1 MiB**; planner dừng nếu headroom < 8 MiB sau batch. **Không cần DROP INDEX, không phát sinh chi phí.** Thêm cột chỉ là metadata. Đo lại ngay trước mỗi GO-D (headroom là số sống; rollback batch cũng ghi thêm version). UNKNOWN: kích thước thực của dòng khi crawl mới có voucher/khuyến mãi dài hơn — đã bù bằng biên 8 MiB.

## 6. Order/quote (1C) — P470-003 + P470-004 TRONG release; kiểm kê đường vào trực tiếp
**Đã kiểm đọc-only trên Production (24/11):** 10 RPC `public.runtime_order_*`/`runtime_quote_*` (SECURITY INVOKER) chỉ role `authenticated` có EXECUTE; `authenticated` còn có **INSERT/UPDATE/DELETE trực tiếp** trên `orders`, `order_items`, `quote_requests`, `quote_items`, `runtime_idempotency_records`, INSERT `runtime_audit_events`, USAGE+SELECT 5 sequence (RLS gắn chủ sở hữu). Đăng ký Supabase Auth **đang BẬT** (email, cần xác nhận email) ⇒ ai tự đăng ký cũng là `authenticated` và dùng khoá publishable qua PostgREST: có thể gọi RPC hoặc **ghi thẳng bảng với tổng tiền tuỳ ý**, không phụ thuộc UI/Worker. 0 đơn, 0 báo giá, 0 `auth.users`; chỉ Edge Function `admin-api` được deploy (không có function đơn/báo giá); Worker Public không có binding order intake; `/api/orders`, `/gio-hang` đóng ⇒ **không có consumer hợp lệ** nào của đường này ở Production.

| Việc | File | Hiệu lực |
|---|---|---|
| Định giá đúng (voucher × số lượng một lần, không fallback legacy, thiếu/UNRESOLVED/REVERIFY/ngừng/inactive ⇒ không tạo đơn có giá, idempotency/snapshot giữ nguyên) | P470-003 | chỉ vệ sinh (`category_id` 1) × TOTO/INAX (`brand_id` 1/2, assert slug); hãng khác & ngành khác **giữ nguyên legacy** |
| Khoá bypass khi commerce OFF | P470-004 | `REVOKE` 6 RPC ghi + INSERT/UPDATE/DELETE 5 bảng + audit INSERT + sequence khỏi `authenticated` (anon/service_role/PUBLIC vốn đã không có); giữ SELECT và 4 RPC đọc; kiểm hậu điều kiện, sai ⇒ rollback toàn giao dịch |

Không dựa vào "UI đang OFF": test local chạy bằng role `authenticated` thật — *control* trên ACL baseline thì mọi đường **mở**, sau 004 thì RPC và ghi bảng/sequence đều `permission denied`, đọc vẫn chạy; rollback 004 khôi phục ACL **khớp từng byte**. Không đổi Auth/Edge/Worker/cờ. Mở lại commerce sau này = GO riêng áp 004 rollback. P470-003 và P470-004 độc lập nhau (003 cần 001; 004 không cần gì).

## 7. Audit runtime ngoài giá: candidate vs live `e070986a` (110 file; chỉ các phần có tác động runtime)
| Khu vực (nguồn) | Hành vi Production trên candidate | Gate / bằng chứng |
|---|---|---|
| Giá canonical live-read (#470) | **OFF** mặc định | `PUBLIC_CANONICAL_PRICING` chỉ ghi qua lane M4 (`canonical_pricing`); test cờ OFF = câu lệnh không đổi |
| Series filter + bộ chọn biến thể (#432/#433/#440) | **OFF**: không query sibling/series, `?dong=`/`series_slugs` bị bỏ qua, listing không chạm bảng spec, UI không có gì để render | gate `seriesVariantEnabled()` (`APP_ENV!==production` hoặc `PUBLIC_SERIES_VARIANT=on`); test `series-variant-gate.test.ts` + PG ACL **có và không có** quyền series. **Chip biến thể legacy trên PDP vẫn còn** (Owner chấp nhận khác biệt giao diện 24/11) như live (đường legacy: cùng `variant_group` + cùng hãng + cùng sub-category, public, tối đa 8, chỉ cột Public đã có quyền; KHÔNG bảng spec/series, không cần grant #432). Khác live đúng 1 điểm: chip hiển thị bằng `VerifiedVariantSelector` (SKU + `variant_label` của chính SKU, không suy từ tên) thay vì `VariantSelector` cũ (không có xem trước giá/ảnh biến thể trên PDP); loại thêm nhóm bị quarantine #431 |
| Giỏ hàng / checkout / order Public (#446) | **Đóng** ở cả tầng ứng dụng (`/gio-hang` 404, `POST /api/orders` `not-found`, không có binding `ORDER_INTAKE_DB`) **và tầng DB** (P470-004) | `worker-api-policy.test`, `worker-policy.test`, `gio-hang/page.test` |
| Sort giá + control (#447) | chỉ khi giá canonical ON và chỉ danh mục vệ sinh; còn lại như live | `listing-query` + PG test |
| Admin giá canonical (#446/#473) | **Hoạt động sau P470-002** (trước đó fail-safe như live): form dùng 3 trường canonical **chỉ cho vệ sinh × TOTO/INAX**; hãng/ngành khác vẫn quản lý giá legacy như live (không đổi); ghi ngoài phạm vi bị `PRICE_SCOPE_INVALID`; bật lại SKU luôn được phép: giá cũ > 7 ngày/không rõ thời điểm ⇒ `REVERIFY_REQUIRED` (giữ giá + `checked_at`, **không nâng**, Public/đơn coi như chưa xác minh) và Admin thấy lý do + nút “Xác minh giá”; SKU TOTO/INAX không bắt buộc nhập giá để kích hoạt | `externalGrant` + probe 60 s; test Admin API thật trên PG |
| Khoá cache HTML | thêm biến thể giá khi cờ ON; OFF = khoá cũ | `page-cache.test` |
| Nhãn truy vấn `public-db` | chỉ thêm nhãn | — |
| Công cụ Hita/CSV/crawl, docs, retire workflow, identity allowlist | không chạy trong Worker | không ảnh hưởng runtime |
Không thay đổi: SKU/URL, ngành/hãng ngoài phạm vi, Blog, media, auth Admin, SEO ngoài `Offer` canonical (JSON-LD chỉ khi có giá).

## 8. Bằng chứng (local/CI; không phải PASS Production)
Xem bình luận báo cáo trong #470: lint, typecheck, vitest toàn repo, `run-local.sh` + `import-local.sh`, tích hợp PG 13 pha với ACL/RLS thật (gồm gate series OFF khi quyền series tồn tại, tổ hợp cờ hãng TOTO/INAX, SKU inactive có giá không lộ, chip biến thể legacy), `import-local.sh` hai hãng × hai trạng thái (cô lập chéo hãng, `is_active` đồng thời, rollback từng plan), build combined Public+Admin off/on + `wrangler deploy --dry-run`, CI trên đúng head #479. `run-local.sh` nay gồm 003 theo hãng, kiểm *control* mở/đóng của 004 bằng role `authenticated`, rollback 004 khớp ACL từng byte; `import-local.sh` có thêm plan ứng viên (áp dụng/rollback). **UNKNOWN:** Worker local (`wrangler dev --remote`) cho cache/Hyperdrive thật và hành vi trên Production thật (chưa làm hosted theo quy định). Đăng ký Supabase Auth đã xác minh đọc-only (§6).

## 9. Giá ứng viên Owner-accepted (quy tắc #443 comment 7127072994; TL note 7127074691)
Gói Codex có 1.339 ứng viên lịch sử (giá đơn, hãng chỉ được chứng minh gián tiếp): TOTO active 87, TOTO inactive 393, INAX active 467, INAX inactive 392. Planner ứng viên (`prod-import.mts --owner-candidates approval.json`, `prod-import-candidates.mts`) **không bao giờ nhập một tệp ứng viên một mình**:
- cần **file duyệt của Owner** ghim sha256 CSV + danh sách `dpg_id` được duyệt + tham chiếu quyết định; thiếu/đổi CSV/không có id ⇒ kế hoạch dừng hoặc rỗng;
- mỗi dòng phải: SKU đầy đủ khớp 3 nơi (`dpg_sku = source_sku = search_sku`), `EXACT_SKU*`, độ tin cậy MODERATE/HIGH, VND, **một giá duy nhất** (KM/voucher trống), giá PDP = Offer = CSV, không trùng id trang Hita giữa các SKU, danh tính khớp DB (hãng/trạng thái/ngành/SKU), còn mới ≤ 7 ngày (hết hạn ⇒ phải refresh ở nguồn, **không đổi timestamp/hạn**), không ghi đè giá đã lưu/Hita-verified và không ghi đè chỉnh sửa Admin mới hơn;
- ghi **chỉ `regular_price_vnd`** (KM/voucher NULL), status `PRICE_VERIFIED`, `canonical_price_checked_at` = **thời điểm nguồn**; nguồn/URL/độ tin cậy/rule/tham chiếu duyệt nằm trong **ledger/manifest** với `price_basis=OWNER_ACCEPTED_CANDIDATE`, `not_direct_hita_verified=true`;
- plan/ledger/checksum/rollback riêng (một plan ứng viên cho mỗi hãng × trạng thái), `is_active` không bao giờ bị ghi.
Kết quả chạy offline trên gói thật (chưa có file duyệt ⇒ nhập được 0; với giả định duyệt hết phạm vi): TOTO inactive **393**, INAX active **467**, INAX inactive **392** đạt mọi quy tắc (= 1.252 đã có đối chiếu gián tiếp); **TOTO active 87 bị loại 87/87** (`match_type`/`confidence` trống: bằng chứng hãng chưa lưu) — đúng với “87 TOTO active rà bổ sung”. 547 INAX baseline stale và 30 WARN xử lý riêng, planner không đụng timestamp.

## 10. Khoảng trống cần báo (không tự mở rộng)
- **Provenance ở mức dòng DB:** cột DB hiện chỉ có trạng thái + 3 giá + `checked_at`; Owner-accepted và Hita trực tiếp cùng là `PRICE_VERIFIED` trong DB (Public không hiển thị chữ “Hita” nên không có tuyên bố sai trên giao diện). Phân biệt nằm ở ledger/manifest/ledger sha. Nếu Owner muốn phân biệt ngay trong DB/Admin thì cần thêm 1 cột nhỏ (quyết định riêng; không làm trong candidate này).
- **Planner chưa dựng CSV ứng viên mới:** chỉ nhận tệp Codex theo hai bố cục hiện có (INAX và TOTO) và dừng nếu thiếu cột.
- **Chính sách 7 ngày** dùng chung cho kích hoạt lại và độ mới ứng viên (hằng `CANONICAL_REACTIVATION_MAX_AGE_MS`, `CANDIDATE_MAX_AGE_HOURS`).

