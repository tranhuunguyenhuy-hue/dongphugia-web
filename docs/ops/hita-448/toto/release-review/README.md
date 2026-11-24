# #448 · Gói nghiệm thu dữ liệu TOTO đợt 1

Phạm vi gồm 2.057 SKU TOTO active, ngành thiết bị vệ sinh. Nguồn là [CSV #463 đã pin](https://github.com/tranhuunguyenhuy-hue/dongphugia-web/blob/a361612a7cd49deeadccae37b623daaca5fe9126/docs/ops/hita-448/toto/toto_prices_review.csv), đối chiếu [gate #467](https://github.com/tranhuunguyenhuy-hue/dongphugia-web/pull/467) và [manifest #470 tại head được báo cáo](https://github.com/tranhuunguyenhuy-hue/dongphugia-web/blob/2f84954a051bd17c55e0a4e9970ae2311b57e3a0/docs/ops/price-release-470/release-manifest.md). Đối chiếu ID/SKU/brand/category/active với inventory Production đã lưu, batch và checkpoint. Lọc đúng 2.057 dòng active và giữ giá trị mọi cột của CSV gốc. SHA-256 đầu vào ghi trong [tóm tắt audit](audit-summary.json).

| Trạng thái | SKU | Xử lý khi duyệt dữ liệu |
|---|---:|---|
| PRICE_VERIFIED | 1.543 | Giá đã qua gate thời điểm audit, gồm 771 có voucher; cần nguồn mới và phê duyệt trước cutover |
| CONTACT | 283 | Ba trường giá trống; Public “Liên hệ báo giá” |
| DISCONTINUED | 49 | Giữ SKU và kết quả nguồn lịch sử, để Owner quyết vòng đời |
| NOT_FOUND | 1 | Giữ SKU, chỉ đưa vào danh sách xem lại |
| UNKNOWN | 147 | Chưa xác minh; không hiện giá, “Cần liên hệ xác nhận giá” |
| AMBIGUOUS | 34 | Chưa xác minh; không hiện giá, “Cần liên hệ xác nhận giá” |

## 28 voucher cần Owner duyệt

Tỷ lệ voucher trên giá bán sau khuyến mãi từ **30,77% đến 67,50%**. Giá gốc, giá bán, số voucher, nguyên mã và promotion ID đều khớp giữa bằng chứng PDP/Offer và autocomplete. PDP ghi “Giảm thêm” khi đặt online tại Hita, ghi riêng điều kiện gốc từng dòng.

- **26 đủ bằng chứng số tiền lịch sử**, còn chờ xác minh điều kiện và duyệt để sử dụng cho DPG.
- **2 nghi vấn khả dụng** gồm `TBW10000V` và `TBW10020V`. Autocomplete ghi số lượng 0, Offer ghi `InStock`. Bằng chứng đủ cho số tiền lịch sử nhưng chưa xác nhận khả dụng của ưu đãi.
- **0 thiếu bằng chứng số tiền**. Điều kiện được lưu nhắc đến Hita; cần xác minh tính áp dụng và thời hạn trước khi đưa voucher lên DPG. Voucher chỉ là ưu đãi riêng.

## 181 dòng chưa xác minh

| Chẩn đoán theo quy tắc parser #478 và bằng chứng đã lưu | SKU |
|---|---:|
| Giá đơn exact SKU khớp PDP/Offer VND; trường hãng từ PDP không được lưu | 87 |
| Hai giá hiển thị nhưng thiếu nhãn xác nhận giá gốc | 14 |
| Thiếu Offer cho exact SKU | 4 |
| URL bị parser từ chối; thiếu raw để xác minh URL hoặc query biến thể | 42 |
| Search thiếu exact hit | 33 |
| PDP trả mã khác | 1 |

Không có raw HTML TOTO tương ứng trong batch/checkpoint/pilot đã lưu để chạy lại parser đầy đủ. Đối chiếu trường bằng chứng đã trích bằng cùng quy tắc giá đơn đã sửa ở #478. **0 dòng được nâng lên PRICE_VERIFIED**. 87 ứng viên lịch sử có mã PDP/Offer khớp được tách riêng để review. 94 dòng còn lại không đủ căn cứ giá để đưa vào danh sách ứng viên; không dùng giá của biến thể.

## Cổng dữ liệu và thời điểm nguồn

Gate #467 chạy ở chế độ import-review trên chính CSV active, với inventory 2.057 dòng. **0 FAIL, 28 WARN** đều thuộc voucher; gate ghi 147 `UNRESOLVED` và 34 `AMBIGUOUS_UNVERIFIED`. Phần còn thiếu xác minh là **181/2.057**. Không có lỗi trùng hoặc lệch ID/SKU so với inventory đã lưu.

Dữ liệu active được thu ngày **23/11/2026 18:23–20:09 UTC**. Cả 1.543 Offer của dòng có giá ghi `2026-12-01` trong `priceValidUntil`. Đây là trường hạn từ nguồn, không có bằng chứng là hạn riêng của từng ưu đãi. CSV giữ nguyên timestamp và hạn. Gói đủ để nghiệm thu dữ liệu offline. Trước cutover cần refresh hợp lệ trong tập TOTO active, ưu tiên 181 chưa xác minh và 28 voucher, rồi pin CSV mới, chạy gate lại và chờ Owner duyệt phạm vi cùng giá tại [#449](https://github.com/tranhuunguyenhuy-hue/dongphugia-web/issues/449). 0 request Hita trong lượt này, không ghi DB hoặc deploy.

- [CSV 2.057 active](toto_active_review.csv) · [514 dòng không có giá trong baseline](toto_active_exceptions.csv)
- [28 voucher cho Owner](toto_voucher_owner_review.csv) · [181 dòng chưa xác minh](toto_unresolved_review.csv) · [87 ứng viên lịch sử](toto_historical_candidates.csv)
- [Quality gate](quality-gate.json) · [Checksum](SHA256SUMS)
