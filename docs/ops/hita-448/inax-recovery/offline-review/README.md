# #477 · Ứng viên giá lịch sử INAX

Áp dụng quyết định Owner [7125968574](https://github.com/tranhuunguyenhuy-hue/dongphugia-web/issues/477#issuecomment-7125968574) trên dữ liệu #448 và CSV #478 đã pin. Phạm vi là 2.090 SKU thiết bị vệ sinh. Giá ứng viên dùng để review và cần xác minh lại trước cutover.

| Nhóm | SKU | Giá có sẵn #478 | Ứng viên mới | Có giá hoặc ứng viên | Còn thiếu |
|---|---:|---:|---:|---:|---:|
| Active | 1.653 | 852 | 467 | 1.319 (79,79%) | 334 |
| Inactive | 437 | 8 | 392 | 400 (91,53%) | 37 |
| Tổng | 2.090 | 860 | 859 | 1.719 (82,25%) | 371 |

Active đạt mốc tối thiểu 376 ứng viên và còn thiếu 3 SKU so với mục tiêu 470. Độ phủ giá hoặc ứng viên toàn ngành INAX trong phạm vi tăng từ 41,15% lên 82,25%.

## Quy tắc và kết quả đối chiếu

- Kiểm đủ 862 dòng bằng chứng giá đơn trong 1.195 SKU từ #478. Có 859 ứng viên nhóm B, confidence MODERATE, exact SKU kể cả hậu tố. Dòng ứng viên cần mã PDP, mã autocomplete và DPG khớp, giá PDP/Offer VND/giá lặp trong autocomplete khớp, đồng thời cả mô tả đầy đủ và cấu hình trong tên DPG khớp slug PDP có hãng. Chuẩn hóa dấu tiếng Việt và dấu phân cách chỉ để so mô tả với slug. Giữ nguyên mã nguồn và mã DPG. Mô tả và slug có thể cùng nguồn, vẫn thiếu xác nhận hãng trực tiếp từ PDP.
- Kiểm trùng theo SKU trong hai inventory INAX/TOTO đã lưu (6.822 SKU) và trùng Hita product ID trong batch hai hãng. Không phát hiện collision trong phạm vi dữ liệu có sẵn. Chưa có inventory đầy đủ các hãng còn lại.
- Giữ unresolved 3 mã `BFV-1003S`, `BFV-1003S-2C` và `B-2557-VN@401(LFV-1402)`. Hai URL đầu thiếu hãng trên slug và có biến thể gần nhau. Mã thứ ba có cấu hình `(LFV-1402)` trong mã PDP nhưng thiếu cấu hình đó trong tên và slug.
- Đã rà 102 trường hợp search thiếu exact hit. 99 có gợi ý tìm kiếm. 45 có gợi ý khớp mã của một PDP đã lưu cho SKU khác. Không có bằng chứng tương đương cấu hình cùng giá PDP/Offer cho SKU đích nên có 0 ứng viên alias giá. Gợi ý được lưu trong CSV unresolved để review. Giữ ghi nhận nguồn lịch sử cho 118 CONTACT và 113 DISCONTINUED.
- Kiểm mẫu 60 active, lấy 20 mã có dấu phân cách cấu hình, 20 mã có hậu tố số và 20 exact còn lại. 60/60 dòng khớp nguyên mã, cấu hình trong tên/slug và giá PDP/Offer. Cả 105 trường hợp thiếu bằng chứng nhận diện hoặc cần review alias được giữ ngoài danh sách giá ứng viên. Chỉ có giá đơn, giá khuyến mãi và voucher để trống.

CSV #478 giữ nguyên byte. Quality gate import-review chạy lại trên CSV #478 đã pin tại mốc gate gốc, kết quả trùng gói đã merge với 0 FAIL, 2 WARN, 1.746 UNRESOLVED. CSV ứng viên sử dụng các cột giá lịch sử riêng. Lượt làm gửi 0 request Hita. Không ghi DB hoặc deploy.

- [859 ứng viên](historical-price-candidates.csv)
- [336 dòng còn lại trong tập 1.195](unresolved-review.csv)
- [Mẫu 60 active](active-sample.csv)
- [Checksum CSV](SHA256SUMS)

## Input đã pin

- #448 batch prices.json SHA-256 `96bffa9d4d1e4fa72ff8a3095d94ed7e6c7c5d66bace4a694a0bf588bb4c9298`
- #448 batch checkpoint SHA-256 `f50df0d867f645843b54a8d6705a895ff6e931bda7b5fd83917254c72e79a888`
- Inventory INAX SHA-256 `3e00e01dfbe45ad2e6a5b6630e0e98dda12c36f399296b76f6ff49614932e1bb`
- Inventory TOTO SHA-256 `a289fba405507c532d7e1ba5566de1aede04b24a4ea946d65fcd43b699db0a13`
- Batch TOTO SHA-256 `2f02defe8161003676c7bd2982fa581b958c74f4c88c77e3b192451c08d9269b`
- #478 recovery.csv SHA-256 `189355bb90f6d73f699114fdcfa8cbdfe979bb7ad0756d56a5c77b0b5e14a96b`
- #478 sanitary-merged.csv SHA-256 `e425c48958e8119e585fd257648de7adf8a2f04c1d1f9cf3d6c6f7e798009acc`
