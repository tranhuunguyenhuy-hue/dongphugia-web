# #448 · Nghiệm thu TOTO và INAX, bàn giao dữ liệu cho Claude

**Đã đối soát đủ 6.531 SKU. Lượt này xác nhận hiện hành được 0/4.648 giá tiềm năng.** Crawler hiện có kiểm tra `https://hita.com.vn/robots.txt` lúc **2026-11-24 09:38:55 UTC**, nhận HTTP 403 và dừng sau một request. Không truy vấn PDP, không tìm thêm giá cho 599 SKU còn thiếu. Tất cả giá tiềm năng giữ HOLD cho đến khi xác nhận tính hiện hành bằng nguồn được phép.

## Phân loại đủ 6.531 SKU

Các cột giá bên dưới là tổ hợp **tiềm năng đang HOLD**. Đã tính 29 voucher TOTO theo đề xuất để trống. Giá gốc + voucher không có dòng nào.

| Hãng / trạng thái | Tổng | Gốc + KM + voucher | Gốc + KM | Chỉ gốc | Gốc + voucher | CONTACT | Nguồn DISCONTINUED | NOT_FOUND | UNRESOLVED |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| TOTO active | 2.057 | 743 | 800 | 67 | 0 | 283 | 49 | 1 | 114 |
| TOTO inactive | 2.384 | 2 | 924 | 393 | 0 | 677 | 258 | 1 | 129 |
| INAX active | 1.653 | 358 | 189 | 772 | 0 | 8 | 8 | 2 | 316 |
| INAX inactive | 437 | 0 | 0 | 400 | 0 | 1 | 0 | 0 | 36 |
| **Tổng** | **6.531** | **1.103** | **1.913** | **1.632** | **0** | **969** | **315** | **4** | **595** |

| Nhóm cần quyết định | TOTO active | TOTO inactive | INAX active | INAX inactive | Tổng |
|---|---:|---:|---:|---:|---:|
| Giá đã qua gate lịch sử, còn phải xác nhận hiện hành | 1.543 | 926 | 305 | 8 | **2.782** |
| Ứng viên giá đơn, chờ xác nhận hiện hành và Owner duyệt theo dòng | 67 | 393 | 467 | 392 | **1.319** |
| INAX baseline, chờ xác nhận giá/ưu đãi | 0 | 0 | 547 | 0 | **547** |
| **Tổng HOLD** | **1.610** | **1.319** | **1.319** | **400** | **4.648** |
| Voucher TOTO đề xuất để trống, đã nằm trong HOLD | 28 | 1 | 0 | 0 | **29** |

2.929 SKU active và 1.719 SKU inactive có giá tiềm năng. 599 SKU để trống gồm 20 ứng viên thiếu căn cứ và 579 SKU chưa xác minh hoặc không tìm thấy. 969 CONTACT giữ kết quả báo giá. 315 DISCONTINUED phản ánh ghi nhận của nguồn, giữ nguyên trạng thái kinh doanh của DPG. Không xóa, ẩn hoặc kích hoạt SKU.

547 INAX baseline bao gồm 358 voucher và 2 cảnh báo giảm sâu. Số tiền đã đối chiếu offline ở #483; lượt này chưa xác nhận được giá, thời hạn hay điều kiện áp dụng. Nhãn baseline không chứng minh Offer đã hết hạn. Không coi điều kiện voucher chỉ áp dụng tại Hita là điều kiện của DPG. 29 voucher TOTO vẫn đề xuất NULL; giá gốc/KM của các dòng đó còn nằm trong HOLD.

## Kết quả gate và phần Claude nhận

- **PASS đối soát và cấu trúc.** Bốn CSV trạng thái theo contract #470 chạy gate `import-review` với inventory thật đã lưu. **1.284 dòng CONTACT/DISCONTINUED, 0 FAIL, 0 WARN, 0 dòng giá số.** Đây là xác nhận cấu trúc và bằng chứng lịch sử, chưa cấp quyền cập nhật trạng thái.
- **UNKNOWN tính hiện hành.** Có 0 dòng đủ điều kiện chạy gate cho giá mới. Không chạy gate giá trên tập HOLD, không phát hành CSV giá trực tiếp cho import và không tạo file Owner approval. 2.782 PASS ở gate lịch sử giữ nguyên ý nghĩa tại thời điểm audit.
- **Handoff tách hai lane theo hãng/trạng thái.** `status-review.csv` dùng bố cục planner thường, còn `candidate-review.csv` dùng contract ứng viên tại #479 head `4e674728bb04374f3ea327b0707c0f67bbf856c2`. Candidate có exact SKU ba nơi, PDP/Offer VND, giá đơn, Hita page ID, rule ref, thời gian nguồn gốc, dấu HOLD và cờ chưa duyệt. Sau khi xác nhận lại nguồn, Owner mới duyệt danh sách ID + SHA CSV + tham chiếu cho candidate lane. Ledger/manifest #470 phân biệt Owner-accepted với Hita trực tiếp; DB hiện chưa có trường provenance riêng. Claude cần giữ phân tách này, chưa thay #479.
- **Chốt trước nhập.** Khi có nguồn được phép, ưu tiên TOTO/INAX active, 1.319 ứng viên, 547 INAX baseline và WARN. Refresh từng giá dự kiến dùng theo #466, giữ UTC/hạn từ nguồn. Pin CSV mới, chạy gate theo tập thật, lập dry-run/plan từ snapshot được duyệt và xin GO từng tập ở [#449](https://github.com/tranhuunguyenhuy-hue/dongphugia-web/issues/449). Có thể duyệt phần đủ điều kiện trước; inactive tiếp tục không hiển thị Public.

| Tập | Manifest | CSV trạng thái | CSV ứng viên HOLD |
|---|---|---|---|
| TOTO active | [JSON](toto-active/manifest.json) | [332 dòng](toto-active/status-review.csv) | [67 dòng](toto-active/candidate-review.csv) |
| TOTO inactive | [JSON](toto-inactive/manifest.json) | [935 dòng](toto-inactive/status-review.csv) | [393 dòng](toto-inactive/candidate-review.csv) |
| INAX active | [JSON](inax-active/manifest.json) | [16 dòng](inax-active/status-review.csv) | [467 dòng](inax-active/candidate-review.csv) |
| INAX inactive | [JSON](inax-inactive/manifest.json) | [1 dòng](inax-inactive/status-review.csv) | [392 dòng](inax-inactive/candidate-review.csv) |

- [Sổ review 6.531 SKU](all-sku-review.csv) có nguồn, timestamp, lý do, kết quả HOLD và giá lưu dùng để review.
- [1.883 dòng trạng thái hoặc chưa có giá](non-price-and-deferred.csv) gồm 599 dòng tạm dừng tìm giá.
- [Tóm tắt, pin đầu vào](summary.json) · [Checksum đầu ra](SHA256SUMS).

Không ghi Database, backup/export hosted hoặc deploy. PR #483 dữ liệu nguồn đã merge sau khi CI PASS. #479 giữ nguyên.
