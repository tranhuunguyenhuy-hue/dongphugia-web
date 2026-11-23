# #448 · Giá Hita cho TOTO

Báo cáo cập nhật lúc 2026-11-23T18:55:33.729Z. Phạm vi: đọc nguồn công khai và xuất dữ liệu để Owner duyệt.

## Kết quả

| Mục | Số SKU |
|---|---:|
| Inventory thiết bị vệ sinh TOTO trên DPG | 4.441 |
| DPG active, đưa vào danh sách ưu tiên | 2.057 |
| DPG inactive, crawl sau nhóm active | 2.384 |
| Có kết quả kiểm trong đợt này (active / inactive) | 731 (731 / 0) |
| SKU khớp đúng mã trên PDP, kể cả trang không công bố giá | 661 |
| SKU có giá đủ bằng chứng | 533 |
| Trong số giá mới, có giá gốc / khuyến mãi / voucher | 533 / 533 / 207 |
| SKU chưa có giá đủ bằng chứng | 3.908 |
| SKU chưa kiểm trong đợt crawl | 3.710 |

- `AMBIGUOUS`: 32
- `CONTACT`: 52
- `DISCONTINUED`: 16
- `EXACT`: 533
- `NOT_CRAWLED`: 3.710
- `NOT_FOUND`: 1
- `UNKNOWN`: 97

Pilot #450: 7 requests, không bị chặn
Batch #461: 731 SKU có checkpoint, phiên thực thi bị ngắt, báo cáo dùng checkpoint đã lưu

## Bằng chứng và phạm vi

- Inventory từ SELECT catalogue DPG Production, brand ID 1, danh mục `thiet-bi-ve-sinh`; các dòng theo trạng thái active. Không đọc khách hàng hay đơn hàng.
- Crawler Node fetch + Cheerio tái sử dụng #450 và batch #461, tuần tự, khoảng cách tối thiểu 1 giây. Kiểm SKU trên PDP, giá HTML và Offer JSON-LD. Dòng khớp ghi URL, giờ UTC, hạn Offer và điều kiện voucher nếu có.
- CSV chính có đủ 4.441 dòng inventory active và inactive. Tình trạng crawl theo từng SKU được ghi riêng. File inactive chỉ phục vụ đối soát trạng thái sản phẩm.
- Giá pilot cũ, nếu có, giữ giờ gốc và nhãn `STALE_PILOT_2026-11-22`. Giá rỗng, lỗi kỹ thuật và các SKU chưa xử lý được phân biệt trong CSV. Giá Hita có đủ bằng chứng vẫn chờ Owner duyệt.
- Không ghi cơ sở dữ liệu, không triển khai Production hoặc Staging. Offline crawler regression: 37/37.

## Tải file

- [CSV giá và trạng thái toàn bộ TOTO](toto_prices_review.csv)
- [CSV ngoại lệ](toto_exceptions.csv)
- [CSV inventory TOTO inactive](toto_inactive_inventory.csv)
