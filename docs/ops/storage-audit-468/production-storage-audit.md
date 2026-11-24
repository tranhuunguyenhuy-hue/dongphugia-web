# #468 — Kiểm toán dung lượng Production (chỉ SELECT)

**Đo lúc 2026-11-24 02:57 UTC**, project `bonxyxluzlxfkdetryoo` (PostgreSQL 17.11). Chỉ `SELECT`/catalog: không ghi, không VACUUM/REINDEX, không đổi cấu hình, không crawl, không đụng Codex. Không đọc dữ liệu cá nhân, đơn hàng hay secret; các so khớp nội dung chỉ trả về số đếm và kích thước. Đây là phương án để Tech Lead/Owner duyệt, **chưa hành động**. **Bản sửa (24/11, #470 Bước 2):** làm rõ phân loại index theo review của Tech Lead; không có DDL/DML nào được chạy.

## 1. Kết luận (đọc phần này là đủ)
1. Database **279,74 MiB**, còn **70,26 MiB** tới ngưỡng chặn **350 MiB** (self-imposed guard LEO-538, không phải hạn mức gói; hạn mức gói chưa được xác minh).
2. **Cơ hội tiết kiệm lớn nhất, ít rủi ro nhất, giảm dung lượng thật:** **27 cặp index có cùng khóa** (không phải "27 cặp hoàn toàn giống nhau"): **20 cặp trùng hoàn toàn** (cả hai bản đều UNIQUE, cùng cột/opclass/collation/predicate) và **7 cặp cùng khóa nhưng khác UNIQUE** (một bản UNIQUE, một bản không). Tổng bản ứng viên bỏ **19,57 MiB**, trong đó **chỉ nhóm A (7 index lớn của cặp trùng hoàn toàn) = 19,12 MiB đủ bằng chứng để đề xuất**; 20 index còn lại (0,45 MiB) lợi ích không đáng kể so với rủi ro lệch schema nên **chờ kiểm chứng thêm / đề nghị giữ**. `DROP INDEX` xóa file nên `pg_database_size` giảm ngay. Headroom có điều kiện: **70,26 → khoảng 89,4 MiB** nếu chỉ thực hiện nhóm A (số đo lúc 02:57 UTC, thay đổi theo thời gian). **Chưa có DROP nào được thực hiện hay được duyệt.**
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
| **A** | **7 index lớn của cặp trùng hoàn toàn** (nhóm A, chi tiết mục 4b): giữ bản gắn ràng buộc UNIQUE `direct_parity_N`, bỏ bản độc lập | **19,12 MiB** | **Đo + kiểm chứng:** cùng khóa/opclass/collation/predicate/INCLUDE, cùng UNIQUE; bản bỏ không gắn ràng buộc/FK nào; 6/7 truy vấn khóa đang dùng bản được giữ (EXPLAIN) | **Có, ngay** (xóa file index) | **Thấp về dữ liệu**, nhưng **lệch `schema.prisma`/migration `leo538`** (mục 4b); DDL cần Owner duyệt |
| **B** | Index **không trùng nhưng 0 lượt dùng** trong ~53 ngày | ≈ 11,2 MiB (GIN `idx_products_specs` 6,77; `idx_product_spec_values_text` 1,53; `idx_product_source_mappings_sku` 0,89; `idx_products_hita_id` 0,64; còn lại < 0,3) | **Đo** số lần quét; **chưa đủ** để kết luận bỏ: chỉ ~53 ngày thống kê, chưa biết tải theo mùa; mã không thấy truy vấn lọc `specs` (chỉ đọc sau khi tải), `hita_product_id` được Admin đọc/ghi | Có, nếu bỏ | **Trung bình**, cần xác nhận dùng thật trước khi quyết |
| **C** | `products.description` **trùng** `product_descriptions.clean_html` | **≈ 13,5 MiB** (17.044 hàng bằng nhau; 708 hàng khác/rỗng) | **Kiểm chứng** bằng so khớp từng hàng | Chỉ sau khi **ghi lại bảng** (xem mục 6); 14 file mã đọc `description` | **Cao hơn:** cần quyết định nguồn dữ liệu duy nhất + sửa mã + kiểm thử |
| **D** | `product_descriptions.raw_html` (6.861 hàng) + `clean_issues` | 9,70 + 3,82 MiB (kích thước đã nén) | **Đo** kích thước; **chưa kiểm** có cần để làm sạch lại hay không (`raw_html` rỗng ở 10.891 hàng; `raw_html ≠ clean_html` ở mọi hàng có dữ liệu) | Chỉ sau ghi lại bảng | Cần Owner quyết định giữ/lưu ngoài DB |
| E | `product_images` heap dư | ≈ 5,2 MiB (ước tính) | **Ước tính** từ 99.961 UPDATE; không có `pgstattuple` | Chỉ sau ghi lại bảng | Thấp giá trị, tốn công |

**Không đề xuất xóa dữ liệu:** `m5_cdn_ledger` (24 MiB, sổ cái chuẩn hóa CDN), `product_source_mappings`, `product_documents`, `product_spec_values` có heap gọn và không có bằng chứng dữ liệu thừa. Tên bảng hoặc số hàng không phải bằng chứng; cần Owner xác nhận mục đích giữ lại.

## 4b. Index ứng viên: phương pháp, bảng cụ thể và an toàn (Bước 2 #470)
**Phương pháp phân loại (SELECT trên `pg_index`/`pg_class`/`pg_constraint`/`pg_stat_user_indexes`, 2026-11-24 ~04:15 UTC).** Hai index vào cùng một nhóm khi trùng **tất cả**: bảng, danh sách cột (`indkey`), opclass, collation, tùy chọn (`indoption`), biểu thức, predicate, số cột khóa/INCLUDE, phương thức truy cập (btree). Sau đó tách theo cờ **UNIQUE**: (i) **IDENTICAL_UNIQUE** = cả hai UNIQUE (20 cặp); (ii) **UNIQUE_VS_NONUNIQUE** = một bản UNIQUE, một bản không (7 cặp). Lỗi trong bản trước: so khớp định nghĩa đã bỏ từ khóa `UNIQUE`, nên gộp nhầm hai loại này thành "27 trùng hệt". Không index nào trong 27 cặp có predicate, biểu thức hay `NULLS NOT DISTINCT`; tất cả btree và hợp lệ (`indisvalid`).

**Cơ sở chọn bản giữ/bỏ.** Với cặp (i): giữ bản gắn **ràng buộc UNIQUE** `direct_parity_N` (có dòng trong `pg_constraint`), bỏ bản độc lập `*_key`/`uq_*` (không ràng buộc hay FK nào trỏ vào). Với cặp (ii): giữ bản UNIQUE, bỏ bản không-unique (bản UNIQUE phục vụ mọi truy vấn của bản kia). Kiểm tra phụ thuộc: không ràng buộc/FK nào có `conindid` là bản bỏ.

**Ba nhóm bằng chứng** (bảng đầy đủ 27 dòng kèm SQL DROP và rollback chính xác: `docs/ops/storage-audit-468/index-candidates.csv`):
| Nhóm | Gồm | Dung lượng | Kết luận |
|---|---|---:|---|
| **A. Đủ bằng chứng đề xuất bỏ** | 7 index IDENTICAL_UNIQUE lớn nhất | **19,12 MiB** | Đề xuất xem xét (cần Owner duyệt), chưa làm |
| **B. Chờ kiểm chứng thêm / đề nghị giữ** | 13 index IDENTICAL_UNIQUE nhỏ (< 0,1 MiB mỗi cái) + 7 cặp UNIQUE_VS_NONUNIQUE | 0,45 MiB | Lợi ích không đáng kể; rủi ro lệch schema; không đề xuất |
| **C. Giữ lại** | mọi bản được giữ (20 `direct_parity_N`, các `*_key` UNIQUE của cặp khác UNIQUE) và mọi index khác | n/a | Không đổi |

**Nhóm A (chi tiết; lượt quét tính từ 2026-10-02):**
| Bảng | Bỏ | Giữ (gắn ràng buộc) | Khóa | Bỏ (MiB) | Quét bỏ / giữ |
|---|---|---|---|---:|---|
| `product_spec_values` | `uq_product_spec_option` | `direct_parity_12` | (product_id, spec_definition_id, option_id) | 5,898 | 0 / 59.672 |
| `product_source_mappings` | `uq_product_source_mappings_source_url` | `direct_parity_11` | (source, source_url) | 4,891 | 0 / 0 |
| `product_documents` | `uq_product_documents_product_url` | `direct_parity_7` | (product_id, url) | 3,852 | 0 / 1.247 |
| `products` | `products_category_id_slug_key` | `direct_parity_17` | (category_id, slug) | 2,031 | 31 / 158.701 |
| `products` | `products_sku_key` | `direct_parity_18` | (sku) | 0,891 | 27 / 285 |
| `product_package_items` | `uq_product_package_items_product_label` | `direct_parity_10` | (product_id, label) | 0,844 | 0 / 1.238 |
| `product_descriptions` | `product_descriptions_product_id_key` | `direct_parity_5` | (product_id) | 0,711 | 0 / 109.237 |
| **Tổng nhóm A** | | | | **19,118** | |

**Kế hoạch truy vấn thực tế (EXPLAIN, không thực thi):** với các khóa trên, planner **đã dùng bản được giữ** cho `products` (sku; category+slug), `product_spec_values`, `product_documents`, `product_package_items`, `product_descriptions`. Riêng `product_source_mappings`, truy vấn (source, source_url) **không dùng cả hai bản** (planner chọn `idx_product_source_mappings_source_product` rồi lọc), nên bỏ bản trùng không đổi kế hoạch. Vì vậy bỏ bản độc lập **không kỳ vọng đổi kế hoạch** ở cả 7 trường hợp; cần chạy lại 7 EXPLAIN này sau khi thực hiện để xác nhận.

**Rủi ro và điều kiện (nhóm A):**
- **Ràng buộc dữ liệu:** tính UNIQUE vẫn do `direct_parity_N` (ràng buộc) đảm bảo suốt quá trình, không có khoảng hở. Bản bỏ không phải ràng buộc nên `DROP INDEX` là đủ, không cần `ALTER TABLE … DROP CONSTRAINT`.
- **Lệch schema (cần xác nhận trước khi duyệt):** `prisma/schema.prisma` và migration `leo538_runtime_schema.sql` **khai báo chính các index này** (ví dụ `@@unique(..., map: "uq_product_documents_product_url")`, `CREATE UNIQUE INDEX "products_sku_key"`). Nếu Prisma/migration còn được dùng với Production, bỏ chúng gây lệch khi `prisma db pull/migrate diff` hoặc khi dựng lại DB. **Chưa kiểm chứng** Prisma có được dùng với Production hay không; nếu bỏ, phải cập nhật schema/migration cùng lúc (PR riêng).
- **Khóa bảng:** `DROP INDEX` thường lấy khóa độc quyền ngắn trên bảng; `DROP INDEX CONCURRENTLY` chờ các giao dịch đang dùng index kết thúc rồi mới xóa. Trạng thái lúc đo (một thời điểm): 14 phiên, 2 đang chạy, giao dịch cũ nhất ≈ 0 giây, 0 khóa chưa cấp, 0 prepared transaction. Cấu hình hiện tại: `lock_timeout = 0` (không giới hạn), `statement_timeout = 120 s`.
- **Chạy `CONCURRENTLY`:** không chạy trong khối giao dịch và chỉ một index mỗi lệnh; cần từng lệnh riêng, ngoài transaction, trên kết nối ghi (ví dụ phiên autocommit của vai trò migration). **Tôi chưa kiểm chứng** công cụ chạy SQL của Owner có tự bọc giao dịch hay không (không thử vì cấm DDL). Trước mỗi lệnh đặt `SET lock_timeout = '5s'`; sau lỗi/hủy, kiểm tra `indisvalid`/`indisready` của index (có thể còn ở trạng thái không hợp lệ) rồi chạy lại hoặc tạo lại.
- **Rollback:** `CREATE UNIQUE INDEX CONCURRENTLY <tên> ON <bảng> USING btree (<cột>)` đúng định nghĩa trong CSV (UNIQUE, btree, không predicate). Cần chỗ tạm xấp xỉ kích thước index (≤ 5,9 MiB) và vài giây đến vài chục giây; thuộc tính được phục hồi vì đây là index độc lập.
- **Ngưỡng an toàn:** thực hiện khi dung lượng ≤ 300 MiB (còn dư ≥ 50 MiB) để việc tạo lại index khi rollback luôn nằm trong headroom (hiện 279,74 MiB). Sau mỗi `DROP`, đo lại `pg_database_size` (kỳ vọng giảm bằng kích thước index) và chạy lại EXPLAIN tương ứng.
- **Sao lưu:** `pg_get_indexdef` của 7 index đã có trong CSV; không bảng nào bị đổi dữ liệu nên không cần restore dữ liệu.
- **Headroom có điều kiện:** 70,26 → khoảng **89,4 MiB** (chỉ nhóm A); chỉ đúng nếu không có ghi lớn đồng thời.

## 5. Rủi ro 350 MiB khi nạp giá (ước tính từ số đo)
- Hàng `products` ≈ 2.115 byte heap (37.543.936 byte / 17.752 hàng); chỉ 2,2% UPDATE là HOT nên **mỗi hàng đổi sẽ ghi thêm một bản heap và một mục trong cả 30 index** (index 20,2 MiB).
- Tăng tạm thời **trước khi dọn lại**: TOTO (4.441 hàng) ≈ **+14,0 MiB** (heap 9,0 + index 5,1); toàn ngành vệ sinh (16.447 hàng) ≈ **+52 MiB** (heap 33,2 + index 18,7). Với 279,7 MiB hiện tại, đỉnh ≈ 332 MiB: **chỉ còn dư khoảng 18 MiB** so với ngưỡng.
- Autovacuum chỉ làm không gian đó **tái sử dụng được**, không trả về hệ thống. `DROP COLUMN`, `UPDATE … NULL`, `DELETE` cũng **không** làm `pg_database_size` giảm.
- Gỡ trước 2 index độc lập trùng trên `products` (2,03 + 0,89 MiB, nhóm A) còn giảm số mục ghi mỗi lần UPDATE.

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

## 8. Đề xuất bước nhỏ nhất tiếp theo (cần Owner duyệt DDL riêng, sau khi Tech Lead review)
1. Xác nhận Prisma/migration có còn áp dụng cho Production không (mục 4b); nếu có, chuẩn bị PR cập nhật schema cùng lúc.
2. **Nhóm A (7 index, 19,12 MiB)** bằng `DROP INDEX CONCURRENTLY` từng cái, ngoài transaction, theo thứ tự `product_spec_values`, `product_source_mappings`, `product_documents`, `products` (category+slug), `products` (sku), `product_package_items`, `product_descriptions`; mỗi bước đo dung lượng và chạy lại EXPLAIN tương ứng. Rollback theo `index-candidates.csv`.
3. Nhóm B không đề xuất. Sau đó mới kế hoạch nạp theo lô (#466/#470), đo dung lượng giữa các lô.
4. Các cơ hội B/C/D của mục 4 (index không dùng, nội dung trùng) chỉ khi Owner/Tech Lead muốn giảm thêm; mỗi mục cần kiểm tra mã/nghiệp vụ trước.

## 9. Đã kiểm chứng và cần thêm thông tin
**Đã kiểm chứng (số đo/so khớp):** dung lượng, ngưỡng, headroom; kích thước heap/index/TOAST và dead tuple các bảng lớn; 27 cặp index cùng khóa (20 trùng hoàn toàn + 7 khác UNIQUE), kích thước, ràng buộc, lượt quét; kế hoạch truy vấn (EXPLAIN) của 7 khóa; trigger và phạm vi; `products.description = clean_html` ở 17.044 hàng; tỷ lệ HOT của `products`.
**Ước tính:** phình heap `product_images` (≈ 5,2 MiB), mức tăng khi nạp (≈ 14/52 MiB), đỉnh ghi lại bảng.
**Cần thêm:** Prisma/migration có còn áp dụng cho Production không; công cụ chạy SQL của Owner có chạy được `CONCURRENTLY` ngoài transaction không; hạn mức dung lượng thật của gói Supabase (không đọc được bằng SQL); thống kê dùng index dài hơn 53 ngày; xác nhận mã có dùng các index ở nhóm B; quyết định nghiệp vụ cho C/D; phình index thật (cần `pgstattuple`/công cụ ngoài, không cài trong lượt này).

## Phụ lục: truy vấn chính (chỉ SELECT, 2026-11-24 ~02:57 UTC)
```sql
-- tổng quan
select now(), pg_database_size(current_database()), 367001600 - pg_database_size(current_database());
-- bảng lớn
select n.nspname||'.'||c.relname, pg_total_relation_size(c.oid), pg_relation_size(c.oid), pg_indexes_size(c.oid),
       coalesce(pg_total_relation_size(c.reltoastrelid),0), s.n_live_tup, s.n_dead_tup, s.n_tup_upd, s.n_tup_hot_upd
from pg_class c join pg_namespace n on n.oid=c.relnamespace left join pg_stat_user_tables s on s.relid=c.oid
where c.relkind='r' and n.nspname in ('dpg_app','dpg_control') order by 2 desc;
-- index cùng khóa: chữ ký = bảng + cột + opclass + collation + option + biểu thức + predicate + số cột khóa/INCLUDE + phương thức; rồi tách theo indisunique
select n.nspname||'.'||t.relname, i.relname, x.indisunique, pg_relation_size(i.oid), coalesce(s.idx_scan,0),
       (select string_agg(c.conname||':'||c.contype::text, ',') from pg_constraint c where c.conindid=i.oid),
       concat_ws('|', x.indrelid::text, x.indkey::text, x.indclass::text, x.indcollation::text, x.indoption::text,
                 coalesce(pg_get_expr(x.indexprs,x.indrelid),''), coalesce(pg_get_expr(x.indpred,x.indrelid),''),
                 x.indnkeyatts::text, x.indnatts::text, am.amname::text) as sig
from pg_index x join pg_class i on i.oid=x.indexrelid join pg_class t on t.oid=x.indrelid
join pg_namespace n on n.oid=t.relnamespace join pg_am am on am.oid=i.relam
left join pg_stat_user_indexes s on s.indexrelid=i.oid where n.nspname in ('dpg_app','dpg_control');  -- nhóm theo (bảng, sig) có count > 1
-- nội dung trùng (chỉ trả số đếm/kích thước)
select count(*), sum(pg_column_size(p.description)) from dpg_app.product_descriptions d
join dpg_app.products p on p.id=d.product_id where p.description = d.clean_html;
-- trigger
select c.relname, pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid
join pg_proc p on p.oid=t.tgfoid where p.proname='enforce_free_tier_headroom_statement';
```
