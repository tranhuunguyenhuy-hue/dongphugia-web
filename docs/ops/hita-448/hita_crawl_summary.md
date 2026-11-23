# Hita price crawl — review summary (#448)

**Trạng thái crawl live: LIVE_BLOCKED (`HTTP_403_OR_CHALLENGE`).** Không có giá mới nào được lấy trong lần chạy này. Không ghi database (TEST hay Production), không deploy.

## 1. Độ phủ so với inventory Production
| Mục | Số lượng |
|---|---|
| SKU ngành `thiet-bi-ve-sinh` trên Production (chỉ đọc, 2026-11-23T18:07Z) | **16,447** |
| — đang hiển thị (`is_active`) | 5,344 |
| — SKU phân biệt (không trùng, không rỗng) | 16,447 |
| SKU trong file CSV này (SKU thật của inventory TEST, bỏ 64 fixture tổng hợp) | 72 |
| **Crawl mới thành công trong lượt này** | **0** |
| Có bằng chứng giá CŨ (pilot 22/11, không phải giá mới) | 20 |
| Chưa crawl do bị chặn | 52 |
| Production chưa có trong file | 16,375 |

**Không được hiểu đây là toàn ngành.** Tối đa 72/16,447 SKU (0.44%) có dòng trong CSV, và chỉ 20 dòng có bằng chứng giá (cũ).

## 2. Lần thử crawl live
- Bắt đầu: 2026-11-23T18:08:43.130Z (UTC), công cụ: `scripts/hita-price-audit/batch.mts` (Node fetch + Cheerio, kế thừa #450 và #461), 1 request/giây, User-Agent trung thực.
- Số request thực tế: **1**, không phải 2xx: **1**, mã đầu tiên: HTTP 403.
- Kết quả: Hita trả Cloudflare challenge (`cf-mitigated: challenge`) ngay ở `robots.txt`; crawler dừng theo quy tắc, **không** giải challenge, không đổi IP/UA/proxy, không dùng runner khác để né chặn.
- BLOCKED ≠ "Hita không có giá": các SKU này **không** được kết luận là không có giá.

## 3. Phân bố trong CSV
| status | số dòng |
|---|---|
| AMBIGUOUS | 1 |
| BLOCKED | 52 |
| CONTACT | 1 |
| DISCONTINUED | 2 |
| EXACT | 15 |
| NOT_FOUND | 1 |

| review_status | số dòng |
|---|---|
| NOT_CRAWLED_LIVE_BLOCKED | 52 |
| STALE_PILOT_2026-11-22 | 20 |

Giá đã xác minh (từ bằng chứng pilot 22/11, **cũ**): có giá gốc 15, có giá KM 15, có voucher 9, không giá (CONTACT/DISCONTINUED/NOT_FOUND/AMBIGUOUS) 5. Giá VND là số nguyên > 0 hoặc để trống (không dùng 0).

## 4. File
- `hita_prices_review.csv`
- `hita_exceptions.csv`
- `hita_crawl_summary.md`

Mở bằng Excel: UTF-8 có BOM, ô bắt đầu bằng `=` `+` `-` `@` đã được vô hiệu hóa công thức.

## 5. Còn lại để hoàn thành toàn ngành
1. Hita cho phép truy cập (hoặc cấp nguồn dữ liệu chính thức / chạy trên máy được truy cập hợp lệ).
2. Xuất inventory Production chỉ đọc (id, sku, tên, is_active) rồi chạy `batch.mts` có checkpoint/resume; ví dụ SQL chỉ đọc: `select p.id, p.sku, p.name, p.is_active from dpg_app.products p join dpg_app.categories c on c.id = p.category_id where c.slug = 'thiet-bi-ve-sinh' order by p.id`.
3. Owner duyệt tập dữ liệu mới trước mọi bước ghi DB hoặc #449.
