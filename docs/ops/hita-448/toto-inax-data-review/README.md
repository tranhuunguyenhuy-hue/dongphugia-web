# #448 · Nghiệm thu dữ liệu TOTO và INAX

Đã đối soát **6.531/6.531 SKU thiết bị vệ sinh** theo ID, nguyên mã, hãng, ngành và trạng thái active. Hai CSV giữ nguyên mọi trường nguồn của #463/#478 và không ghi giá ứng viên vào cột giá. Gói TOTO active #481 được dùng lại nguyên dữ liệu, giữ nguyên checksum. Các giá ứng viên từ #480 được giữ nguyên và có CSV riêng.

| Hãng và trạng thái | Tổng SKU | Có giá lưu | Ứng viên lịch sử | Có giá hoặc ứng viên | Chưa có cả hai |
|---|---:|---:|---:|---:|---:|
| TOTO active | 2.057 | 1.543 | 87 | 1.630 | 427 |
| TOTO inactive | 2.384 | 926 | **393 mới** | 1.319 | 1.065 |
| INAX active | 1.653 | 852 | 467 | 1.319 | 334 |
| INAX inactive | 437 | 8 | 392 | 400 | 37 |
| **Tổng** | **6.531** | **3.329** | **1.339** | **4.668 (71,47%)** | **1.863** |

946 ứng viên đã có trước lượt này, cộng 393 TOTO inactive. Các ứng viên chỉ có một giá lịch sử và không trùng 3.329 SKU có giá. Trong 3.329 SKU có giá, **313** chỉ có giá gốc, **1.884** có giá gốc và khuyến mãi, **1.132** có đủ ba trường. Tổng lần lượt có 3.329 giá gốc, 3.016 giá khuyến mãi và 1.132 voucher. Voucher tách riêng. Coverage giá hoặc ứng viên cho active là 2.949/3.710, inactive là 1.719/2.821.

## TOTO inactive và INAX inactive

393 ứng viên mới có exact SKU kể cả phần biểu thị cấu hình, giá hiển thị trên PDP và Offer VND cùng số với autocomplete, và mô tả đầy đủ từ inventory khớp slug PDP có hãng. Các tên có thể cùng nguồn. Hãng được đối chiếu gián tiếp theo quy tắc review lịch sử; confidence MODERATE. Không chấp nhận alias. Kiểm trùng SKU trên inventory lưu INAX/TOTO và ID trang Hita trong hai batch. Còn 61 trường hợp giá đơn thiếu đối chiếu đầy đủ model/cấu hình và một trường hợp ID trang 2480 dùng cho nhiều biến thể tay sen TOTO. 20 mẫu chia hai nhóm có/không dấu cấu hình khớp mã và số tiền. Các trường hợp khác giữ trạng thái nguồn trong bảng ngoại lệ.

37 INAX inactive chưa có giá hoặc ứng viên gồm 31 NOT_CRAWLED, 3 UNKNOWN, 2 AMBIGUOUS và 1 CONTACT. INAX active giữ 547 giá baseline dán nhãn lịch sử và 305 giá lượt #478. 783 INAX active chưa có kết quả giá từ nguồn gồm 772 NOT_CRAWLED, 10 AMBIGUOUS và 1 UNKNOWN; trong đó 467 có ứng viên lịch sử. CONTACT là kết quả báo giá riêng, không gộp với chưa xác minh.

## Gate và những mục cần Owner duyệt

| Tập | Scope gate | FAIL | WARN | PRICE_VERIFIED theo gate | UNRESOLVED + AMBIGUOUS |
|---|---:|---:|---:|---:|---:|
| TOTO toàn bộ | 4.441 | 0 | 28 | 2.469 | 655 + 48 |
| INAX toàn bộ | 2.090 | 0 | 2 | 313 | 1.746 + 12 |
| INAX active | 1.653 | 0 | 2 | 305 | 1.320 + 10 |
| TOTO active (#481) | 2.057 | 0 | 28 | 1.543 | 147 + 34 |

547 giá INAX baseline giữ nhãn stale nên gate phân loại vào UNRESOLVED, dù timestamp tại lúc audit còn trong 24 giờ. Kết quả PRICE_VERIFIED là phân loại kỹ thuật của file ở thời điểm gate. Cả 3.329 giá có trường Offer `priceValidUntil=2026-12-01`. Ngày này từ nguồn, chưa chứng minh là hạn riêng của mỗi ưu đãi. Khoảng thời gian lấy giá là 23/11/2026 18:23–21:40 UTC với TOTO và 24/11/2026 03:04–05:47 UTC với INAX. Không đổi timestamp hoặc hạn.

- **TOTO:** 28 cảnh báo voucher lớn đều thuộc active. Giữ kết luận #481 gồm 26 đủ căn cứ số tiền lịch sử và 2 nghi vấn khả dụng. Ba voucher inactive có giá trị khớp bằng chứng đã lưu; `DU601N` có quantity 0, cần kiểm tra khả dụng nếu dùng sau này.
- **INAX:** 358 voucher đều từ baseline active; số tiền và điều kiện online khớp bằng chứng đã lưu, tỷ lệ cao nhất 6,72% giá bán. Không có WARN voucher lớn. Hai WARN giảm giá sâu gồm `BFV-7145T-3C` và `AC-919R+CW-H17VN/BW1`.
- **Trước cutover:** xác nhận lại inventory active 3.710 SKU, refresh hợp lệ các giá và trạng thái, ưu tiên 964 active chưa xác minh cùng 30 dòng WARN. Owner duyệt giá, voucher và phương án với SKU chưa có bằng chứng, rồi pin CSV mới và chạy lại gate. CONTACT dùng “Liên hệ báo giá”; SKU chưa xác minh giữ giá trống và dùng “Cần liên hệ xác nhận giá”. Inactive chỉ phục vụ đối soát và không thuộc nhập đợt 1. Nếu INAX còn vướng refresh/duyệt, Owner quyết định tách rollout tại [#449](https://github.com/tranhuunguyenhuy-hue/dongphugia-web/issues/449), theo phạm vi đã chốt ở #443.

## File bàn giao

| Hãng | Review cả active và inactive | Ngoại lệ | Ứng viên lịch sử | Gate |
|---|---|---|---|---|
| TOTO | [4.441 dòng](toto_review.csv) | [1.972 dòng](toto_exceptions.csv) | [480 dòng](toto_historical_candidates.csv) | [JSON](toto_quality_gate.json) |
| INAX | [2.090 dòng](inax_review.csv) | [1.230 dòng](inax_exceptions.csv) | [859 dòng](inax_historical_candidates.csv) | [JSON](inax_quality_gate.json) |

- [Danh sách refresh theo hãng và active](refresh_queue.csv) · [30 WARN cho Owner](owner_price_warnings.csv)
- [Đối chiếu TOTO inactive](toto_inactive_evidence_review.csv) · [Mẫu 20 ứng viên](toto_inactive_candidate_sample.csv) · [Voucher inactive](toto_inactive_voucher_review.csv)
- [CSV và gate INAX active](../inax/release-review/) · [Gói TOTO active đã nghiệm thu](../toto/release-review/)
- [Tóm tắt và checksum đầu vào](audit-summary.json) · [Checksum đầu ra](SHA256SUMS)

Audit dùng dữ liệu offline đã lưu. 0 request đến Hita. Không ghi Database, deploy hoặc sửa #479.
