# #448 · Nghiệm thu cuối và bàn giao cho Claude

Đã đối soát đủ **6.531/6.531 SKU**. Áp dụng quyết định Owner [#443](https://github.com/tranhuunguyenhuy-hue/dongphugia-web/issues/443#issuecomment-7127916878) và chỉ thị [#448](https://github.com/tranhuunguyenhuy-hue/dongphugia-web/issues/448#issuecomment-7127917834) lên bằng chứng đã pin ở #483/#484. #484 đã merge sau CI PASS tại `77127cb39f60918b782fe6a1384fb12fb3efdb34`.

**4.101 giá qua được contract offline, 547 HOLD do contract hiện tại.** Tổng 4.648 giá nằm trong ngoại lệ nghiệm thu của Owner. Không có giá nào được xác minh trực tiếp lại ở Hita. Chưa có GO nhập.

| Hãng / trạng thái | SKU | Ứng viên PASS | Giá qua gate lịch sử PASS | Baseline HOLD | CONTACT | Nguồn DISCONTINUED | Chưa xác minh |
|---|---:|---:|---:|---:|---:|---:|---:|
| TOTO active | 2.057 | 67 | 1.543 | 0 | 283 | 49 | 115 |
| TOTO inactive | 2.384 | 393 | 926 | 0 | 677 | 258 | 130 |
| INAX active | 1.653 | 467 | 305 | 547 | 8 | 8 | 318 |
| INAX inactive | 437 | 392 | 8 | 0 | 1 | 0 | 36 |
| **Tổng** | **6.531** | **1.319** | **2.782** | **547** | **969** | **315** | **599** |

4.101 PASS gồm 2.382 active và 1.719 inactive. Tổ hợp PASS gồm **1.632 chỉ giá gốc**, **2.469 giá gốc + KM**, **0 gốc + voucher**, **0 đủ ba trường**. 547 HOLD có 545 gốc + KM và 2 chỉ đề xuất giá gốc. 599 chưa xác minh gồm 4 NOT_FOUND và 595 unresolved, trong đó 20 ứng viên thiếu chứng cứ.

## Ngoại lệ và điều kiện dành cho Claude

- **1.319 ứng viên** giữ exact SKU, ID trang, tiền VND PDP/Offer khớp, nguồn và thời gian gốc. Chỉ giá gốc, KM/voucher NULL. Bốn file `owner-approval.json` đúng schema candidate #479, ghim SHA CSV và danh sách ID, với provenance `OWNER_ACCEPTED_CANDIDATE`. Gate tuổi nguồn mặc định 7 ngày được giữ nguyên, không có dấu hiệu hết hạn trong gói tại lúc kiểm. Đây là chấp nhận theo bằng chứng lưu, không phải xác nhận mới từ Hita.
- **2.782 giá lịch sử** giữ nguyên nhãn gate nguồn, timestamp và hạn Offer, provenance `HITA_ARCHIVED_DIRECT_OWNER_EXCEPTION` nằm trong CSV/ledger. File `archived-direct-approval.json` là bằng chứng quyết định và pin ID/CSV cho Claude, không phải một tham số được planner thường đọc. Không nâng nhãn, không thay ngưỡng tuổi. Gate chạy lại theo giờ thật tại audit, không có lỗi hoặc WARN sau khi tách voucher. Claude cần dừng nếu lần chạy để nhập báo stale/expired, kể cả đã có quyết định nghiệm thu.
- **547 INAX baseline** giữ nhãn stale và giữ nguyên dữ liệu gốc. Contract #479 vẫn bỏ qua cả 547 vì chưa có lane nhận ngoại lệ baseline tương ứng. Với hai cảnh báo giảm sâu, chỉ giữ giá gốc trong đề xuất riêng cho tới khi rõ điều kiện KM. Không đổi nhãn để vượt gate. Yêu cầu Claude xử lý tối thiểu phần tương thích này nếu Owner muốn đưa baseline vào một plan sau; không sửa #479 trong lượt bàn giao.
- **1.132 voucher để trống trong đề xuất.** Gồm 29 TOTO theo chỉ thị, và 1.103 dòng còn lại (745 TOTO, 358 INAX) có bằng chứng điều kiện ghi chỉ áp dụng tại Hita, chưa có chính sách DPG phù hợp trong gói quyết định. Số tiền và điều kiện gốc được giữ trong danh sách voucher HOLD, không loại giá gốc/KM đủ căn cứ.
- **Gate thực tế** chạy hàm planner thuần túy ở #479 head `c76ea39f19593bf38754ea9c3328c62d0ecd1db8` trên inventory đã lưu và fixture version/giá trống. Kết quả 1.319 ứng viên và 2.782 giá lịch sử, 0 lệch danh tính. Đây là kiểm tra hợp đồng offline; khóa chống ghi đè giá/phiên bản Admin, headroom, backup và điều kiện GO của dữ liệu live vẫn phải kiểm riêng. Không tạo SQL hay plan để apply.

## Bàn giao bốn tập

| Tập | Manifest | Giá lịch sử + pin | Ứng viên + Owner approval |
|---|---|---|---|
| TOTO active | [JSON](toto-active/manifest.json) | [CSV](toto-active/archived-direct.csv) · [Pin](toto-active/archived-direct-approval.json) | [CSV](toto-active/candidate.csv) · [Duyệt](toto-active/owner-approval.json) |
| TOTO inactive | [JSON](toto-inactive/manifest.json) | [CSV](toto-inactive/archived-direct.csv) · [Pin](toto-inactive/archived-direct-approval.json) | [CSV](toto-inactive/candidate.csv) · [Duyệt](toto-inactive/owner-approval.json) |
| INAX active | [JSON](inax-active/manifest.json) | [CSV](inax-active/archived-direct.csv) · [Pin](inax-active/archived-direct-approval.json) | [CSV](inax-active/candidate.csv) · [Duyệt](inax-active/owner-approval.json) |
| INAX inactive | [JSON](inax-inactive/manifest.json) | [CSV](inax-inactive/archived-direct.csv) · [Pin](inax-inactive/archived-direct-approval.json) | [CSV](inax-inactive/candidate.csv) · [Duyệt](inax-inactive/owner-approval.json) |

- [Sổ toàn bộ SKU](scope-index.csv) · [Baseline HOLD](inax-active/inax-baseline-hold.csv) · [Pin quyết định baseline](inax-active/inax-baseline-owner-decision.json) · [Voucher HOLD](voucher-holds.csv)
- [Gate ứng viên](quality-gate.json) · [Gate giá lưu](direct-quality-gate.json) · [Tóm tắt](summary.json) · [Checksum toàn gói](SHA256SUMS)
- Bốn file trạng thái giữ nguyên từ #484, tải theo đường dẫn và SHA được ghim trong từng manifest. CONTACT giữ báo giá; DISCONTINUED là dữ liệu nguồn, không đổi vòng đời DPG.

Không đổi ID, SKU, URL hoặc active/inactive. Không truy cập Hita, ghi Database, chạy SQL, deploy hoặc merge #479. Claude dùng các pin này để chuẩn bị bước tiếp theo theo quyền riêng tại [#449](https://github.com/tranhuunguyenhuy-hue/dongphugia-web/issues/449).
