# #470 — Lane `m6-production-sql-apply`: thiết lập và vận hành (Owner)

Lane duy nhất được phép đổi database Production cho đợt phát hành giá + commerce. Chỉ `workflow_dispatch` từ `main`, actor Owner, `approved_source_sha == github.sha`, môi trường bảo vệ `production-sql-apply`. **Không có input nào nhận SQL, đường dẫn, URL hay tên đối tượng**: file/plan/số dòng lấy từ `scripts/m6/allowlist.json` (ghim sha256; lệch 1 byte = từ chối).

## 1. Thao tác một lần của Owner (chỉ làm sau GO-PROD; bây giờ chưa làm gì)
1. **GitHub → Settings → Environments → New → `production-sql-apply`**: bật *Required reviewers* = Owner; *Deployment branches* = `main`.
2. **Credential vận hành** (secret của environment `production-sql-apply`, tên `M6_OPERATOR_DATABASE_URL`). Chỉ vai trò `postgres` làm được việc (bảng `products` có FORCED RLS, hàm cũ do `postgres` sở hữu, tạo role cần CREATEROLE). Đã kiểm trên Supabase TEST: **không thể** tạo login role riêng rồi `grant postgres` (Supabase từ chối: *permission denied to grant role "postgres"*), nên đường duy nhất là chính `postgres`, dùng **mật khẩu tạm**:
   - Supabase Production → *Project Settings → Database → Reset database password* → đặt mật khẩu mạnh, dùng một lần.
   - Chuỗi kết nối dạng **Session pooler** `postgresql://postgres.bonxyxluzlxfkdetryoo:<mật khẩu>@<host pooler>:5432/postgres?sslmode=require` → dán vào secret trên (không dán vào chat/issue).
   - **Sau khi xong toàn bộ** (mục 4): *Reset database password* lần nữa và **xoá secret**. Nếu Edge Function `admin-api` cần chuỗi mới, chạy lại `m4-production-function-deploy` (`operation=deploy`) rồi smoke `/me`.
3. (Chỉ cho `provision-intake`) secret `M6_CLOUDFLARE_HYPERDRIVE_TOKEN`: API token Cloudflare **chỉ** quyền *Account → Hyperdrive → Edit*, giới hạn account `d54f3402…`; xoá sau khi xong. Lane tạo Hyperdrive riêng cho role intake (caching **tắt**, origin cap 5); Owner đặt repository variable `V1_PUBLIC_COMMERCE_HYPERDRIVE_ID` = id được in ra.

## 2. Cách chạy (Actions → *M6 Production SQL apply* → Run workflow, nhánh `main`)
| operation | thay đổi? | điều kiện |
|---|---|---|
| `preflight` | không | đọc target contract/ref, quyền operator, dung lượng, kết nối, trạng thái |
| `plan-import` (`group`=prices/voucher) | không | in `plan_set_sha256` cho Owner duyệt tại checkpoint |
| `apply-004` | có | backup + GO |
| `apply-schema` | có | backup + GO (commerce 001 + giá 001/002) |
| `apply-import` (`group`, `plan_set_sha256`) | có | backup + GO; plan-set phải khớp; `resume=true` để tiếp tục khi gián đoạn |
| `rollback-import` (`rollback_source_run_id`) | có | backup + GO; version-pinned theo ledger của run apply |
| `rollback-schema` | có | backup + GO; từ chối nếu đã có đơn/báo giá |
| `provision-intake` | có | backup + GO + `apply-schema` đã xong |

Mọi thao tác ghi cần ô `go_prod` = `GO-PROD-<12 ký tự đầu của approved_source_sha>` **và** backup `m4-production-backup` (nhánh main, `operation=backup`, job `backup` có bước dump + job `restore-rehearsal` PASS) hoàn tất **< 2 giờ** — lane tự kiểm bằng GitHub API; backup `probe` hoặc thiếu rehearsal bị từ chối. Mỗi lần chạy còn kiểm: target contract = `dongphugia-runtime` / `ap-southeast-1` / `preview` / trần 367.001.600 B / cho phép ghi; host URL chứa ref Production; operator có BYPASSRLS (+CREATEROLE cho schema); còn ≥ 8 MiB headroom; khoá advisory chống chạy song song; `psql ON_ERROR_STOP`; không in secret.

## 3. Fail-closed & bằng chứng
- Mọi kiểm tra ném `M6_*` rồi dừng, không thử lại ngầm. Import chia lô, mỗi lô có `approved_sha=<plan_sha>`; rollback theo ledger với kiểm tra version (chỉnh sửa Admin mới hơn → dừng `M6_ROLLBACK_STATE_UNEXPECTED`, không ghi đè).
- Artifact `m6-<operation>-<run_id>` (30 ngày): plan, ledger, snapshot sản phẩm — dữ liệu catalogue công khai, **không** credential/PII.
- Chứng minh local (không gọi Production): `bash scripts/m6/tests/run-local.sh <host> <port> <superuser>` (6.531 SKU thật; sai SHA/hash/target, thiếu/quá hạn/probe backup, chạy song song, rollback có đơn, retry sau rollback…) + `npx vitest run scripts/m6`.

## 4. Dọn sau phát hành (nằm trong GO)
Reset mật khẩu `postgres` + xoá `M6_OPERATOR_DATABASE_URL` và `M6_CLOUDFLARE_HYPERDRIVE_TOKEN`; tắt Auth sign-up sau khi xác minh (Supabase → Authentication → Providers → Email: *Allow new users to sign up* = off). Lưu trữ commerce cũ giữ 30 ngày sau khi ổn định; bước F (archive/xoá) cần GO riêng; không xoá backup bắt buộc.
