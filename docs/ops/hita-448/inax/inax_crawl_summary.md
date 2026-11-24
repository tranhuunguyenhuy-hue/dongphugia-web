# Crawl giá Hita — toàn bộ sản phẩm INAX
#448 — kiểm tra nguồn công khai, không ghi cơ sở dữ liệu / không deploy

- Crawl UTC: 2026-11-24T02:59:42.128Z → 2026-11-24T04:22:14.644Z
- Kết quả: 2381/2381 SKU; halt reason: `None`; HTTP requests: 4476 (2 non-2xx)
- Inventory read-only DPG: 2381 SKU, 1773 active, 608 inactive; 2381 ID và 2381 SKU duy nhất.
- Phạm vi gồm cả ba danh mục INAX: gach-op-lat 209, thiet-bi-bep 82, thiet-bi-ve-sinh 2090.

## Kết quả giá

- 2092 SKU có mã khớp chính xác trong kết quả Hita; 594 SKU đạt `EXACT` với giá gốc và giá khuyến mãi có bằng chứng.
- 363 trong số đó có voucher online xác minh; voucher được xuất riêng và không cộng/trừ vào giá khuyến mãi.
- 1787 SKU không có đủ giá xác minh; các giá trị để trống, không dùng giá legacy hay tự suy đoán.

| Danh mục | Tổng SKU | EXACT có giá gốc + KM | Có voucher |
|---|---:|---:|---:|
| gach-op-lat | 209 | 34 | 0 |
| thiet-bi-bep | 82 | 13 | 5 |
| thiet-bi-ve-sinh | 2090 | 547 | 358 |

## Trạng thái chưa xác minh

| Lý do crawler | SKU |
|---|---:|
| PRICE_EVIDENCE_MISSING_OR_CONFLICTING | 1226 |
| INVALID_PDP_URL | 163 |
| SOURCE_CONTACT | 146 |
| SOURCE_DISCONTINUED | 126 |
| NO_EXACT_SEARCH_HIT | 125 |
| The operation was aborted due to timeout | 1 |

## File tải xuống

- [CSV toàn bộ 2.381 sản phẩm INAX](inax_prices_review.csv) — một dòng/SKU, có ba trường giá, URL Hita, giờ UTC, hạn giá nếu có, trạng thái và lý do.
- [CSV 1.787 ngoại lệ](inax_exceptions.csv).
- [Tóm tắt JSON máy đọc được](inax_crawl_summary.json).

Đối soát CSV: 2.381 dòng, ID/SKU duy nhất và khớp inventory; 594 dòng `EXACT`; 1.787 ngoại lệ. Không có giá nào được ghi vào Staging hoặc Production. Không deploy.
