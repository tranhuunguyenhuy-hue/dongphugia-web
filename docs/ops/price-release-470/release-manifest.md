# #470 — RELEASE MANIFEST (candidate, chưa phê duyệt)

**Trạng thái:** ứng viên kỹ thuật để Tech Lead review. **Không** phải GO. Mọi thao tác hosted (backup/export, DDL/DML, import, deploy Edge Function, deploy Worker, bật cờ) chỉ được làm sau **Owner GO riêng nêu đúng các giá trị dưới đây** — GO phải có TRƯỚC khi chạm bất kỳ hệ thống hosted nào. Chuỗi "release binding" do script in ra chỉ là định danh, không thay quyền Owner.

## 1. Định danh
| Mục | Giá trị |
|---|---|
| Target | Supabase Production `bonxyxluzlxfkdetryoo` (`dpg_control.target_contract`: project `dongphugia-runtime`, region `ap-southeast-1`, environment `preview`, ceiling 367001600) · Cloudflare account `d54f3402…1fb1`, Worker `dongphugia-v1-public-production` |
| Live baseline (đọc-only 24/11) | Worker version `45c1e9e7-63a7-4695-b8ae-a671eb6dc1f5` = "M4 Admin release `e070986a19fd`" (2026-11-20); Edge Function `admin-api` v2; Hyperdrive `PUBLIC_DB` (`dpg-v1-public-production-readonly`, user `dpg_public_catalogue`, **query cache disabled**) |
| main lúc tích hợp | `d18ada4` |
| Code candidate | nhánh `claude/470-pricing-release-candidate`, code SHA `465ba5bdbfd61433f0e18f58496dca3c111353e5` (head cuối chỉ thêm tài liệu này) |
| Lane phát hành | `.github/workflows/m4-production-admin-release.yml` (combined Public+Admin, PostgreSQL) — **không** dùng `v1-worker-release.yml` (Public-only, guard từ chối thay Worker có Admin) · Edge Function: `.github/workflows/m4-production-function-deploy.yml` |
| Lane yêu cầu | chạy trên `main` với `approved_source_sha == github.sha` ⇒ candidate phải được merge vào `main` **sau** GO; SHA main sau merge là SHA phát hành cần ghi vào GO |
| CSV | hiện tại `docs/ops/hita-448/toto/toto_prices_review.csv` @ `a361612a`, sha256 `bda8301a86bc9f3d9c9ca01f7297c3183ee6efdcf82f1851b2757580d63ccf26` — **phải thay bằng CSV crawl lại gần cutover** (hạn 2026-12-01 đồng loạt) + Quality Gate `import-review` |
| Plan | `prod-import.mts` sinh plan SHA từ CSV mới + snapshot đọc-only lấy ngay trước import (basis gồm version + checked_at ⇒ plan SHA đổi khi DB đổi) |

## 2. SQL + rollback (sha256 tại code candidate)
| File | sha256 |
|---|---|
| `001_canonical_price_columns.sql` | `9b5237b04f8780256626ca559ef2e660e5cb8efc3cb31fd21dd119380284d189` |
| `001_canonical_price_columns_rollback.sql` | `8091c1e559d510fcf87a2f4af79f8f7517849253c43bdbd8f32f9cc335e7e520` |
| `002_canonical_price_grants.sql` | `a7560699fa3d0f550664a4a3693619fb56dded0a9a6ec6a15e6036e47ae63a1a` |
| `002_canonical_price_grants_rollback.sql` | `d422a04d0e4fcc0ac46e7277068b960218bfa7a19fe5a4cc28a1b7bcb819508f` |
| `003_runtime_order_quote_canonical.sql` | `b2785499bcca4ef274d1855981e2383a38d988790a09dbecb179e3bc6f065891` |
| `003_runtime_order_quote_canonical_rollback.sql` | `25f86bc96e66d698eab345191e7f34b40f69218b5476ca1bdf4e842468a56bcb` |
| `batch-NNNN-apply.sql` / `-rollback.sql`, `ledger.jsonl` | sinh khi lập plan; sha256 ghi vào GO cùng plan SHA |

## 3. Ranh giới phê duyệt (Owner GO phải có trước mỗi nhóm)
- **GO-1 (backup/export):** sao lưu hệ thống 14 ngày (pg_dump logic các bảng `dpg_app` liên quan + định nghĩa hàm, checksum, lưu ngoài nền tảng) và bản giá legacy offline sanitary (checksum, xoá 7 ngày sau cutover ổn định). Chưa làm.
- **GO-2 (thực thi release, một cửa sổ):** đúng thứ tự mục 4, với SHA main sau merge, CSV sha, plan SHA, sha256 SQL/batch, rollback version id Worker hiện hành. Dừng ngay khi một bước FAIL.

## 4. Thứ tự (mỗi bước có kiểm tra trước khi sang bước sau)
1. Preflight đọc-only: target identity, headroom (`pg_database_size`), md5 hàm baseline, Worker version đang chạy, backup GO-1 đã có.
2. `001` (cột + CHECK; metadata-only). 
3. Deploy Edge Function `admin-api` của candidate qua `m4-production-function-deploy.yml` (fail-safe: chưa thấy cột vì 002 chưa cấp ⇒ hành vi cũ). **Phải trước 002**: nếu cấp 002 khi function cũ (v2) còn chạy, function cũ sẽ ghi giá không kèm status ⇒ CHECK từ chối (lỗi Admin).
4. `002` (grants cột) ⇒ function mới tự thấy cột, giữ status nhất quán.
5. Import: snapshot đọc-only → planner → batch apply (từng batch, kiểm row-count/headroom) → đối soát đếm theo status.
6. `003` (hàm order/quote — xem mục 6).
7. Merge candidate vào `main` (theo GO), chạy lane M4 `operation=verify`, `canonical_pricing=off` ⇒ artifact + packaged smoke.
8. Lane M4 `operation=publish`, `canonical_pricing=off`, `rollback_version_id=<version đang chạy>` ⇒ code mới, cờ tắt, Public như cũ.
9. Lane M4 `operation=publish`, `canonical_pricing=on` (cùng SHA) ⇒ bật giá TOTO. Cache HTML key đổi theo cờ ⇒ không phục vụ HTML cũ.
10. Smoke + giám sát 24 h.

## 5. Rollback (Worker và SQL là hai rollback riêng)
Thứ tự: (a) lane M4 `canonical_pricing=off` hoặc `wrangler rollback <version>` → (b) batch rollback (chỉ dòng đã apply, từ chối nếu dòng đã bị sửa sau đó) → (c) `003` rollback → (d) `002` rollback → (e) Edge Function về version trước (nếu cần) → (f) `001` rollback (chỉ khi đã xoá hết giá trị). Ma trận tương thích ở readiness mục 7 (đã test local).

## 6. Hàm order/quote (003)
Public cart/checkout/order vẫn **tắt** và không có Edge Function commerce nào được deploy (chỉ `admin-api`). Nhưng `public.runtime_order_create/quote_create` vẫn EXECUTE được với `authenticated` và hiện định giá theo cột legacy ⇒ nếu bỏ 003, một client có JWT vẫn có thể tạo đơn sanitary theo giá legacy. Khuyến nghị **giữ 003** trong gói (sau import; md5 baseline được assert; rollback khôi phục byte-exact). Không bật commerce. Nếu TL muốn tối thiểu hoá, có thể tách 003 thành gói sau — bước 6 và (c) bỏ ra, không ảnh hưởng hiển thị giá.

## 7. Phạm vi KHÔNG tách được khỏi `main` (blocker cần quyết định)
`main` (`d18ada4`) đã có 89 commit sau bản live `e070986a`, gồm runtime #432/#433/#440 (series facet, bộ chọn biến thể) và #446/#447 (pilot TEST, cart/sort gated). Thử revert #440/#434/#435 trên candidate: **xung đột** với #446 (`product-purchase-panel.tsx`, `live-public-catalogue.ts`) ⇒ không cô lập an toàn mà không viết lại các tính năng đó. Hiện trạng trên candidate: #446/#447 bị gate (chỉ TEST/staging); #432 sibling + series facet **degrade** khi role Production thiếu quyền `spec_definitions.key`/`spec_options.slug` (không 5xx; không bộ chọn biến thể/series); #433/#440 UI bộ chọn biến thể không hiện vì không có sibling. Lane phát hành chỉ build từ `main`, nên mọi release (kể cả không có #470) đều mang các thay đổi này.

## 8. Bằng chứng trên code candidate `465ba5b` (local/offline; không phải PASS Production)
- `npm run lint` 0 lỗi mới · `npm run typecheck` sạch · `tsc` apps/public sạch.
- `vitest run` toàn repo với PostgreSQL 16 local cho test tích hợp: **1619 pass**, 17 skip, 2 fail chỉ ở `environment-worker-wrangler-deploy.test.ts` do sandbox thiếu `apps/environment-worker/node_modules` (CI cài đủ; fail cả trên `main` cục bộ).
- `supabase/prod-prep/470/tests/run-local.sh` (001–003 + rollback, baseline md5 byte-exact, guard định danh target) **ALL PASS**; `import-local.sh` (dry-run, guard SHA/target/brand, partial failure, chỉnh sửa đồng thời, rerun, rollback không ghi đè) **ALL PASS**.
- `scripts/quality/live-canonical/live-canonical.integration.test.ts`: 9 pha trên ACL/RLS thật của role public (trước 001, có 001 chưa 002, sau 002, rollback 002/001; cờ ON/OFF; default/asc/desc; INAX có cột canonical nhưng ngoài phạm vi; cửa sổ 60 s) **PASS**.
- Build offline theo đúng bước lane M4 (`build:public-worker` → `app:assemble-public-worker` → `build-production-admin-worker.mts` → kiểm identity → `wrangler deploy --dry-run`): `canonical_pricing=off` identity PASS (không có biến cờ) · `on` identity PASS (`PUBLIC_CANONICAL_PRICING=on`, `PUBLIC_CANONICAL_PRICE_BRANDS=toto`) · dry-run PASS cả hai (2258,50 KiB / gzip 661,33 KiB) · mã worker/assets **giống hệt** giữa off và on (chỉ khác `worker-artifact-evidence.json` vì config khác) ⇒ cờ chỉ là cấu hình. Lưu ý: biến được chụp lúc build, nên lane phải (và đang) đặt cờ **trước** `build:public-worker`.
