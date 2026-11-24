# #468 — Kiểm toán dung lượng Production (chỉ SELECT)

**Đo lúc 2026-11-24 02:57 UTC**, project `bonxyxluzlxfkdetryoo` (PostgreSQL 17.11). Chỉ `SELECT`/catalog: không ghi, không VACUUM/REINDEX, không đổi cấu hình, không crawl, không đụng Codex. Không đọc dữ liệu cá nhân, đơn hàng hay secret; các so khớp nội dung chỉ trả về số đếm và kích thước. Đây là phương án để Tech Lead/Owner duyệt, **chưa hành động**.

## 1. Kết luận (đọc phần này là đủ)
1. Database **279,74 MiB**, còn **70,26 MiB** tới ngưỡng chặn **350 MiB** (self-imposed guard LEO-538, không phải hạn mức gói; hạn mức gói chưa được xác minh).
2. **Cơ hội tiết kiệm lớn nhất, ít rủi ro nhất, giảm dung lượng thật ngay: 27 index trùng hệt, 19,56 MiB** (đo bằng kích thước file index). `DROP INDEX` xóa file nên `pg_database_size` giảm ngay, không cần ghi lại bảng. Headroom tăng từ 70,3 lên khoảng **89,8 MiB**.
3. Dọn **giá cũ** không giúp: dữ liệu giá cũ của ngành vệ sinh chỉ khoảng 0,35 MiB. Phần nặng nằm ở index và nội dung văn bản.
4. Có **nội dung lưu trùng đã kiểm chứng:** `products.description` bằng `product_descriptions.clean_html` ở **17.044/17.752 hàng (≈13,5 MiB)**. Giảm dung lượng thật cần sửa mã + ghi lại bảng; không làm trong lượt này.
5. **Rủi ro 350 MiB rộng hơn tôi báo trước đó:** trigger gắn trên khoảng **45 bảng** (INSERT/UPDATE), không chỉ `products`. Vượt ngưỡng thì **mọi ghi** vào các bảng đó bị từ chối (đơn hàng, báo giá, phiên Admin, sản phẩm); DELETE vẫn chạy.
6. Nạp giá lên 16.447 SKU có thể tăng tạm thời khoảng **52 MiB** (ước tính từ tỷ lệ HOT thực tế, xem mục 5). Nên **gỡ index trùng trước**, rồi nạp theo lô.

## 2. Số đo (đã kiểm chứng)
| Mục | Giá trị |
|---|---|
| `pg_database_size` | 293.328.563 byte = **279,74 MiB** |
| Ngưỡng chặn trigger | 367.001.600 byte = 350 MiB |
| Còn trống tới ngưỡng | **70,26 MiB** |
| Theo schema (heap+index) | `dpg_app` 210,3 MiB; TOAST 32,6 MiB; `dpg_control` 24,1 MiB; `pg_catalog` 9,4 MiB; `auth` 1,0 MiB |
| Thống kê truy cập | reset 2026-10-02 (khoảng 53 ngày dữ liệu dùng index) |
| Extension có sẵn | `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp` (**không có** `pgstattuple`, nên không đo phình bảng/index chính xác được) |

**Trigger:** `leo538_free_tier_headroom` = `AFTER INSERT OR UPDATE … FOR EACH STATEMENT` trên ~45 bảng `dpg_app`; hàm `enforce_free_tier_headroom_statement()` báo lỗi nếu `pg_database_size > 367001600`. Kiểm tra chạy **sau** câu lệnh nên một UPDATE lớn có thể vượt rồi bị hủy.

## 3. Bảng lớn (heap / index / TOAST, đo)
| Bảng | Tổng | Heap | Index | TOAST | Hàng | Dead | Ghi chú đo |
|---|---:|---:|---:|---:|---:|---:|---|
| `products` | 74,8 | 35,8 | 20,2 (30 index) | 18,7 | 17.752 | 2.335 | 16.363 lần UPDATE, chỉ 363 HOT (2,2%) |
| `product_spec_values` | 40,7 | 18,9 | **21,8** (8) | 0 | 135.311 | 0 | heap gọn (lệch ~1% so với dữ liệu sống) |
| `product_descriptions` | 40,1 | 25,7 | 2,4 | 12,0 | 17.752 | 2.124 | 10.897 UPDATE |
| `product_images` | 33,6 | 25,6 | 7,9 | 0 | 110.321 | 102 | 99.961 UPDATE; heap dư khoảng 20% |
| `dpg_control.m5_cdn_ledger` | 24,0 | 14,4 | 9,6 | 0 | 137.980 | 0 | heap gọn; 1 index (khóa chính, 137.986 lượt dùng) |
| `product_source_mappings` | 18,0 | 4,4 | **13,6** (7) | 0 | 24.560 | 0 | heap gọn |
| `product_documents` | 15,1 | 6,2 | 8,8 (5) | 0 | 22.872 | 61 | heap gọn |

(Đơn vị MiB. "Heap gọn" = so kích thước heap với tổng dữ liệu sống đo bằng `pg_column_size` một lần quét; **là ước tính** vì không có `pgstattuple`.)

## 4. Cơ hội tiết kiệm, xếp theo giá trị/rủi ro
| # | Cơ hội | Khối lượng | Bằng chứng | Giảm dung lượng thật? | Rủi ro / độ khó |
|---|---|---:|---|---|---|
| **A** | **27 index trùng hệt định nghĩa**, giữ bản gắn ràng buộc, bỏ bản không gắn | **19,56 MiB** (7 index ≥ 0,5 MiB = 19,12) | **Đo + kiểm chứng:** cùng bảng, cùng cột/kiểu/điều kiện (`pg_get_indexdef`); bản bỏ có `pg_constraint` = 0; bản giữ gắn ràng buộc và mang hầu hết lượt dùng | **Có, ngay** (xóa file index) | **Thấp.** DDL cần Owner duyệt; `DROP INDEX CONCURRENTLY`; rollback = tạo lại index (≤ 6 MiB tạm) |
| **B** | Index **không trùng nhưng 0 lượt dùng** trong ~53 ngày | ≈ 11,2 MiB (GIN `idx_products_specs` 6,77; `idx_product_spec_values_text` 1,53; `idx_product_source_mappings_sku` 0,89; `idx_products_hita_id` 0,64; còn lại < 0,3) | **Đo** số lần quét; **chưa đủ** để kết luận bỏ: chỉ ~53 ngày thống kê, chưa biết tải theo mùa; mã không thấy truy vấn lọc `specs` (chỉ đọc sau khi tải), `hita_product_id` được Admin đọc/ghi | Có, nếu bỏ | **Trung bình**, cần xác nhận dùng thật trước khi quyết |
| **C** | `products.description` **trùng** `product_descriptions.clean_html` | **≈ 13,5 MiB** (17.044 hàng bằng nhau; 708 hàng khác/rỗng) | **Kiểm chứng** bằng so khớp từng hàng | Chỉ sau khi **ghi lại bảng** (xem mục 6); 14 file mã đọc `description` | **Cao hơn:** cần quyết định nguồn dữ liệu duy nhất + sửa mã + kiểm thử |
| **D** | `product_descriptions.raw_html` (6.861 hàng) + `clean_issues` | 9,70 + 3,82 MiB (kích thước đã nén) | **Đo** kích thước; **chưa kiểm** có cần để làm sạch lại hay không (`raw_html` rỗng ở 10.891 hàng; `raw_html ≠ clean_html` ở mọi hàng có dữ liệu) | Chỉ sau ghi lại bảng | Cần Owner quyết định giữ/lưu ngoài DB |
| E | `product_images` heap dư | ≈ 5,2 MiB (ước tính) | **Ước tính** từ 99.961 UPDATE; không có `pgstattuple` | Chỉ sau ghi lại bảng | Thấp giá trị, tốn công |

**Không đề xuất xóa dữ liệu:** `m5_cdn_ledger` (24 MiB, sổ cái chuẩn hóa CDN), `product_source_mappings`, `product_documents`, `product_spec_values` có heap gọn và không có bằng chứng dữ liệu thừa. Tên bảng hoặc số hàng không phải bằng chứng; cần Owner xác nhận mục đích giữ lại.

## 5. Rủi ro 350 MiB khi nạp giá (ước tính từ số đo)
- Hàng `products` ≈ 2.115 byte heap (37.543.936 byte / 17.752 hàng); chỉ 2,2% UPDATE là HOT nên **mỗi hàng đổi sẽ ghi thêm một bản heap và một mục trong cả 30 index** (index 20,2 MiB).
- Tăng tạm thời **trước khi dọn lại**: TOTO (4.441 hàng) ≈ **+14,0 MiB** (heap 9,0 + index 5,1); toàn ngành vệ sinh (16.447 hàng) ≈ **+52 MiB** (heap 33,2 + index 18,7). Với 279,7 MiB hiện tại, đỉnh ≈ 332 MiB: **chỉ còn dư khoảng 18 MiB** so với ngưỡng.
- Autovacuum chỉ làm không gian đó **tái sử dụng được**, không trả về hệ thống. `DROP COLUMN`, `UPDATE … NULL`, `DELETE` cũng **không** làm `pg_database_size` giảm.
- Gỡ trước 2 index trùng trên `products` (2,03 + 0,89 MiB) còn giảm số mục ghi mỗi lần UPDATE.

## 6. Ghi lại bảng (VACUUM FULL/CLUSTER): đỉnh dung lượng
Ghi lại bảng cần chỗ cho **một bản sao đầy đủ** trước khi xóa bản cũ (đỉnh ≈ kích thước bảng sau khi ghi lại, cộng index/TOAST).
| Bảng | Đỉnh ước tính | So với 70,3 MiB còn trống | Lợi ích đo/ước |
|---|---:|---|---|
| `products` | ≈ 70 đến 75 MiB | **Không an toàn** (bằng hoặc vượt) | chưa đo phình |
| `product_descriptions` | ≈ 40 MiB | vừa, **chưa nên** khi chưa có kết luận C/D | chỉ sau C/D |
| `product_images` | ≈ 28 MiB | vừa | ≈ 5,2 MiB (ước tính) |
| `product_spec_values` | ≈ 40 MiB | vừa | gần như 0 (đã gọn) |
**Không khẳng định VACUUM FULL/CLUSTER chạy được trong headroom 70 MiB** cho `products`; chưa nên làm khi chưa có phương án. Chúng cũng khóa bảng (downtime ghi) trong lúc chạy.

## 7. Ba phương án (chưa hành động)
| | (a) Giữ nguyên, nạp khi còn headroom | (b) Giảm dung lượng bằng dữ liệu đã chứng minh thừa | (c) Tăng giới hạn/tài nguyên |
|---|---|---|---|
| Làm gì | Nạp theo lô nhỏ, đo dung lượng mỗi lô, dừng ở mức an toàn | **Bước A trước** (19,56 MiB), sau đó xét B/C/D từng bước | Nâng gói hoặc nới ngưỡng LEO-538 |
| Lợi ích | Không đổi hạ tầng | Hạ đỉnh nạp từ ≈ 332 xuống ≈ 312 MiB; headroom ≈ 90 MiB | Gỡ rủi ro tận gốc |
| Rủi ro | Dư chỉ khoảng 18 MiB cho toàn ngành; nếu vượt thì mọi ghi bị chặn | A thấp; B/C/D cần xác nhận mã và nghiệp vụ | **Chi phí/ngân sách** (ngân sách hạ tầng tăng thêm hiện là $0, cần Owner duyệt); hạn mức gói chưa xác minh |
| Độ khó | Thấp | A: thấp; C: cao | Thấp về kỹ thuật |
| Backup/downtime | Theo kế hoạch nạp | A: snapshot định nghĩa index; `CONCURRENTLY`, không downtime ghi; C/D cần sao lưu + khóa bảng | Không |

## 8. Đề xuất bước nhỏ nhất tiếp theo (cần Owner duyệt DDL riêng)
1. **Gỡ các index trùng lớn (7 index, 19,12 MiB)** bằng `DROP INDEX CONCURRENTLY`, từng cái, theo thứ tự rủi ro thấp trước; trước đó chụp `pg_get_indexdef`, sau mỗi cái đo lại `pg_database_size` và chạy 1 truy vấn kiểm tra kế hoạch. Rollback = `CREATE UNIQUE INDEX CONCURRENTLY` theo định nghĩa đã chụp.
2. Rồi mới kế hoạch nạp theo lô (#466), đo dung lượng giữa các lô.
3. B/C/D chỉ khi Owner/Tech Lead muốn giảm thêm; mỗi mục cần kiểm tra mã/nghiệp vụ trước.

## 9. Đã kiểm chứng và cần thêm thông tin
**Đã kiểm chứng (số đo/so khớp):** dung lượng, ngưỡng, headroom; kích thước heap/index/TOAST và dead tuple các bảng lớn; 27 index trùng và kích thước; trigger và phạm vi; `products.description = clean_html` ở 17.044 hàng; tỷ lệ HOT của `products`.
**Ước tính:** phình heap `product_images` (≈ 5,2 MiB), mức tăng khi nạp (≈ 14/52 MiB), đỉnh ghi lại bảng.
**Cần thêm:** hạn mức dung lượng thật của gói Supabase (không đọc được bằng SQL); thống kê dùng index dài hơn 53 ngày; xác nhận mã có dùng các index ở nhóm B; quyết định nghiệp vụ cho C/D; phình index thật (cần `pgstattuple`/công cụ ngoài, không cài trong lượt này).

## Phụ lục: truy vấn chính (chỉ SELECT, 2026-11-24 ~02:57 UTC)
```sql
-- tổng quan
select now(), pg_database_size(current_database()), 367001600 - pg_database_size(current_database());
-- bảng lớn
select n.nspname||'.'||c.relname, pg_total_relation_size(c.oid), pg_relation_size(c.oid), pg_indexes_size(c.oid),
       coalesce(pg_total_relation_size(c.reltoastrelid),0), s.n_live_tup, s.n_dead_tup, s.n_tup_upd, s.n_tup_hot_upd
from pg_class c join pg_namespace n on n.oid=c.relnamespace left join pg_stat_user_tables s on s.relid=c.oid
where c.relkind='r' and n.nspname in ('dpg_app','dpg_control') order by 2 desc;
-- index trùng hệt (giữ bản gắn ràng buộc/khóa chính/nhiều lượt dùng nhất, các bản còn lại là ứng viên bỏ)
select tbl, regexp_replace(pg_get_indexdef(i.oid),'^CREATE (UNIQUE )?INDEX \S+ ON ','') def, count(*) ... group by 1,2 having count(*)>1;
-- nội dung trùng (chỉ trả số đếm/kích thước)
select count(*), sum(pg_column_size(p.description)) from dpg_app.product_descriptions d
join dpg_app.products p on p.id=d.product_id where p.description = d.clean_html;
-- trigger
select c.relname, pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid
join pg_proc p on p.oid=t.tgfoid where p.proname='enforce_free_tier_headroom_statement';
```
