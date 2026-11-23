# #448 · Giá Hita cho TOTO

Báo cáo cập nhật lúc 2026-11-23T18:27:25.942Z. Phạm vi: đọc nguồn công khai và xuất dữ liệu để Owner duyệt.

## Kết quả

| Mục | Số SKU |
|---|---:|
| Inventory thiết bị vệ sinh TOTO trên DPG | 4.441 |
| DPG active, đưa vào danh sách ưu tiên | 2.057 |
| DPG inactive, giữ danh sách đối soát riêng | 2.384 |
| Active có kết quả kiểm mới trong phiên | 100 |
| Active khớp đúng SKU trên PDP, kể cả trang không công bố giá | 100 |
| Active có giá mới đủ bằng chứng | 88 |
| Trong số giá mới, có giá gốc / khuyến mãi / voucher | 88 / 88 / 60 |
| Active chưa có giá mới đủ bằng chứng | 1.969 |
| Active chưa kiểm trong lượt crawl | 1.957 |

- `CONTACT`: 4
- `DISCONTINUED`: 5
- `EXACT`: 88
- `NOT_CRAWLED`: 1.956
- `UNKNOWN`: 4

Pilot #450: 7 requests, không bị chặn
Batch #461: 100 SKU có checkpoint, dừng chủ động tại checkpoint để bàn giao lượt đầu

## Bằng chứng và phạm vi

- Inventory từ SELECT catalogue DPG Production, brand ID 1, danh mục `thiet-bi-ve-sinh`; các dòng theo trạng thái active. Không đọc khách hàng hay đơn hàng.
- Crawler Node fetch + Cheerio tái sử dụng #450 và batch #461, tuần tự, khoảng cách tối thiểu 1 giây. Kiểm SKU trên PDP, giá HTML và Offer JSON-LD. Dòng khớp ghi URL, giờ UTC, hạn Offer và điều kiện voucher nếu có.
- Phạm vi active còn lại cần xử lý từ checkpoint. Tập inactive chỉ là inventory đối soát.
- Giá pilot cũ, nếu có, giữ giờ gốc và nhãn `STALE_PILOT_2026-11-22`. Giá rỗng, lỗi kỹ thuật và các SKU chưa xử lý được phân biệt trong CSV. Giá Hita có đủ bằng chứng vẫn chờ Owner duyệt.
- Không ghi cơ sở dữ liệu, không triển khai Production hoặc Staging. Offline crawler regression: 37/37.

## Tải file

- [CSV giá TOTO active](toto_prices_review.csv)
- [CSV ngoại lệ](toto_exceptions.csv)
- [CSV inventory TOTO inactive](toto_inactive_inventory.csv)
