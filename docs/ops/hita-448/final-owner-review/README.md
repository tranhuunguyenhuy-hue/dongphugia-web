# #448 · Bảng quyết định cuối về giá TOTO và INAX

Đối soát đủ **6.531 SKU** với inventory đã lưu, gồm 3.710 active và 2.821 inactive. Gói này áp dụng quy tắc có điều kiện tại [#448](https://github.com/tranhuunguyenhuy-hue/dongphugia-web/issues/448#issuecomment-7127073813) lên dữ liệu #482 exact head `c23331e466a55bc064d31a2b37c4cb7b68369c53`. TOTO active #481, INAX recovery #478/#480, CSV #482, timestamp và trạng thái sản phẩm được giữ nguyên.

| Hãng / trạng thái | SKU | Giá quan sát | Giá đạt gate #482 | Ứng viên đề xuất | Ứng viên thiếu căn cứ | Giá baseline cần xác minh lại | Voucher đề xuất NULL | Cần refresh hoặc xác minh lại* |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| TOTO active | 2.057 | 1.543 | 1.543 | 67 | 20 | 0 | 28 | 1.630 |
| TOTO inactive | 2.384 | 926 | 926 | 393 | 0 | 0 | 1 | 1.319 |
| INAX active | 1.653 | 852 | 305 | 467 | 0 | 547 | 0 | 1.319 |
| INAX inactive | 437 | 8 | 8 | 392 | 0 | 0 | 0 | 400 |
| **Tổng** | **6.531** | **3.329** | **2.782** | **1.319** | **20** | **547** | **29** | **4.668** |

\* Gồm mọi dòng có giá quan sát hoặc ứng viên lịch sử. 20 ứng viên thiếu căn cứ cần xác minh nhận diện trước khi xem xét giá. Không cộng 547 baseline lần nữa vào tổng quan sát. Trong tập nghiệm thu trọng điểm có **1.915 ID duy nhất** gồm 1.339 ứng viên, 547 baseline và 31 dòng cần xem giá/voucher, trừ 2 INAX nằm đồng thời ở baseline và cảnh báo. Cả hai gate nguồn #482 có 0 lỗi chặn. Phân loại gate là kết quả tại thời điểm kiểm tra; vẫn cần xác minh lại giá trước cutover.

## 1.339 ứng viên lịch sử

- **1.319 ACCEPT_PROPOSED**, trong đó giữ kết quả đủ bằng chứng cho 1.252 ứng viên đã đối chiếu gián tiếp. Tận dụng mẫu 80/80 đã PASS. Tất cả ứng viên được kiểm mã PDP, mã autocomplete và mã DPG giữ nguyên hậu tố, giá PDP/Offer VND và các giá lưu trong autocomplete khớp. So trùng SKU từ inventory TOTO/INAX và ID trang từ hai batch. Chưa có inventory toàn bộ các hãng; tên DPG và slug có thể cùng nguồn.
- **Rà đủ 87 TOTO active**. 63 giữ đủ model/cấu hình trong tên và slug. Thêm 4 có cùng mã cấu hình đi kèm nhưng vị trí trong slug khác tên, gồm `HB4068-688`, `HB4610-688`, `HTSV838`, `HTSV823`. 20 còn lại thiếu hãng/model/cấu hình đầy đủ từ chứng cứ lưu, gồm ví dụ `LPT239CR#W` và `TX823C1-2WS`. Không tự bỏ hậu tố hoặc gán giá sibling.
- Cả 1.339 dòng mang `REFRESH_REQUIRED`. Chỉ 1.319 dòng đề xuất có giá gốc. Giá khuyến mãi và voucher trong đề xuất giá đơn đều NULL; 20 dòng còn lại không có giá đề xuất. Các mức giá đều chờ xác nhận lại và quyết định từng dòng của Owner.

## 547 giá INAX baseline và 31 dòng cần xem

- **547 INAX active giữ nhãn stale của #478/#482**. Đối chiếu lại 547 giá gốc/KM và 358 voucher đều khớp bằng chứng tiền, ID, nguyên SKU, URL và UTC từ #448. Tại thời điểm audit, capture khoảng 5–6 giờ trước; stale là trạng thái giữ baseline, không phải kết luận hết hạn theo 24 giờ. Cần xác minh lại PDP exact SKU, hãng, giá và điều kiện voucher đang áp dụng. Chưa đề xuất giá riêng cho tập này.
- **28 WARN voucher TOTO active** và **1 trường hợp inactive `DU601N`**. Số tiền đều khớp bằng chứng lưu; 26 có bằng chứng số tiền lịch sử, 3 cần kiểm tra khả dụng vì quantity 0 (`TBW10000V`, `TBW10020V`, `DU601N`). Điều kiện đã lưu áp dụng khi đặt online tại Hita. Đề xuất để voucher NULL cho 29 dòng trong khi chờ xác minh tính áp dụng; có thể giữ giá gốc/KM đã đối chiếu sau khi refresh và Owner duyệt.
- **2 WARN giảm sâu INAX** (`BFV-7145T-3C`, `AC-919R+CW-H17VN/BW1`) nằm trong 547 stale. Hai số tiền khớp dữ liệu đã lưu, nhưng phải xác minh giá và điều kiện khuyến mãi trước khi chọn giá/voucher. Cả hai giữ trạng thái HOLD, không đếm hai lần và chưa đề xuất payload.

## Quyết định trước khi phát hành

Owner cần duyệt giá sau khi có dữ liệu mới từ nguồn được phép, xác nhận điều kiện ưu đãi và chốt nhóm đủ điều kiện tại [#449](https://github.com/tranhuunguyenhuy-hue/dongphugia-web/issues/449). Có thể xử lý từng hãng/trạng thái theo mức bằng chứng. Dòng CONTACT giữ “Liên hệ báo giá”; dòng chưa xác minh giữ giá trống; giữ nguyên cả 6.531 sản phẩm, `is_active`, SKU, URL, ngành, hãng và trạng thái kinh doanh. Inactive tiếp tục không hiển thị Public.

Lượt này offline, gửi 0 request tới Hita. Không có xác nhận độ mới mới nào, không ghi Database, không deploy và không sửa #479.

- [Bảng quyết định toàn bộ 6.531 SKU](owner_decisions.csv)
- [1.339 dòng ứng viên và bằng chứng](historical_candidate_decisions.csv)
- [547 INAX baseline cần xác minh lại](inax_stale_review.csv)
- [30 WARN và DU601N](price_warning_decisions.csv)
- [Số liệu và checksum đầu vào](decision-summary.json) · [Checksum đầu ra](SHA256SUMS)
