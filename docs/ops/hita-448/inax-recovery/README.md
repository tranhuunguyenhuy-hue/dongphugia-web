# #477 · Khôi phục giá Hita cho INAX

Phạm vi gồm 2.090 SKU thiết bị vệ sinh INAX trong danh mục đã chốt tại `9e4733bc55ec87cd52642482a4a1904c8aace04b`. Đối chiếu 2.090 ID/SKU/danh mục/trạng thái và giữ 547 dòng giá từ #448 với timestamp cũ. Có 1.653 SKU active, trong đó 547 có giá theo baseline (33,1%). 244 ngoại lệ gạch/bếp nằm ngoài phạm vi.

## Nguyên nhân và pilot

| Nhóm trong mẫu phân tầng | SKU | Kết quả thực nghiệm |
|---|---:|---|
| Có giá baseline | 12 | Parser cũ và mới cùng giữ đúng giá; 8 có voucher |
| Lỗi bằng chứng giá | 54 | 53 PDP công bố một giá; bảng so sánh ẩn/rỗng, Offer xác nhận giá bán, autocomplete lặp giá bán vào cả hai trường |
| Lỗi bằng chứng giá còn lại | 1 trong 54 | HTML ghi `P-CWS15VN-8-2`; Offer JSON-LD ghi `A-CWS15VN-8`; giá giữ trống |
| Search thiếu mã chính xác | 14 | 12 có kết quả gần giống, 2 không có hit; thử cách đặt khoảng trắng quanh dấu phân cách cho discovery, vẫn xác minh nguyên mã |
| CONTACT / DISCONTINUED | 9 / 8 | Hita báo liên hệ hoặc ngừng kinh doanh; giá để trống |
| URL biến thể | 3 | Kết quả đính kèm `?vid=`; quality gate #467 hiện từ chối URL có query. Giữ nguyên query trong bằng chứng, đưa các SKU vào ngoại lệ |

Trong dữ liệu crawl gốc, 1.175/1.176 dòng thuộc nhóm lỗi bằng chứng có cùng dấu hiệu giá đơn (PDP và Offer có cùng một giá, autocomplete lặp lại). Trường hợp còn lại là xung đột mã ở trên. Kiểm thử hồi quy xác nhận CSV cũ đã xuất được giá đơn nếu parser trả `EXACT`. Nguyên nhân loại giá nằm ở so sánh input autocomplete với ô giá gốc rỗng. Fixture lấy đoạn tối thiểu từ PDP công khai của `C-504VAN/BW1`, có giá 3.640.000₫, giá khuyến mãi và voucher để trống.

Đối chiếu tham chiếu dùng trình đọc DOM độc lập với Cheerio để kiểm SKU, hãng, số tiền/nhãn hiển thị, điều kiện voucher và xem các trường hợp ngoại lệ. Mẫu là phân tầng, có SKU gợi ý và đối chứng, nên không dùng tỷ lệ pilot để ước lượng toàn ngành. Một phần tử Offer dạng mảng được xử lý, nhiều Offer chính xác vẫn cần review. Trường hợp Offer thiếu hoặc mang mã khác vẫn giữ trống. URL chuyển hướng hiện được giữ dưới dạng ngoại lệ, không tự đi theo.

| Phân loại trên 100 SKU | Parser cũ | Parser mới |
|---|---:|---:|
| Nhận đúng giá hiển thị | 12 | 65 |
| Bỏ sót giá hiển thị | 54 | 1 |
| Nhận nhầm giá | 0 | 0 |
| Không nhận giá khi chưa có bằng chứng hiển thị phù hợp | 34 | 34 |

Pilot phục hồi **53/54 (98,1%)** SKU có giá hiển thị trong nhóm lỗi. Cả ba trường giá, kể cả ô trống, khớp tham chiếu ở **65/65** dòng được chấp nhận (cũ 12/12). Kiểm tra parser cũ 184 request; pilot 133 request. Hai lượt đều có 0 non-2xx.

- [100 dòng audit với giá và mã nguồn](audit-100.csv)
- [Số liệu pilot](audit-metrics.json)
- [URL theo biến thể phát hiện trong mẫu](variant-url-review.csv)

## Kết quả crawl lại

Crawl lại **348/1.543 ngoại lệ**. Kết quả mới có **313 giá**, trong đó 305 SKU active và 8 SKU inactive. Đã đối chiếu bản xuất đủ 2.090 SKU, giữ đúng ba giá, URL, timestamp và điều kiện voucher của cả 547 dòng baseline.

| Nhóm | Tổng SKU | Có giá baseline | Có giá mới | Tổng có giá |
|---|---:|---:|---:|---:|
| Active | 1.653 | 547 | 305 | 852 |
| Inactive | 437 | 0 | 8 | 8 |
| Tổng | 2.090 | 547 | 313 | 860 |

| Trạng thái recovery | Active | Inactive |
|---|---:|---:|
| AMBIGUOUS | 10 | 2 |
| CONTACT | 8 | 1 |
| DISCONTINUED | 8 | 0 |
| EXACT | 305 | 8 |
| NOT_CRAWLED | 772 | 423 |
| NOT_FOUND | 2 | 0 |
| UNKNOWN | 1 | 3 |

Giá mới theo số trường xác minh (1 / 2 / 3): 313 / 0 / 0. Voucher mới: 0.

| Lý do chưa có giá | SKU |
|---|---:|
| PENDING_HTTP_403_OR_CHALLENGE | 1.195 |
| NO_EXACT_SEARCH_HIT | 14 |
| SOURCE_CONTACT | 9 |
| SOURCE_DISCONTINUED | 8 |
| INVALID_PDP_URL | 3 |
| EXACT_OFFER_MISSING | 1 |

Batch chạy 2026-11-24T05:42:40.770Z đến 2026-11-24T05:47:32.073Z. Pilot tái sử dụng 88 kết quả ngoại lệ, sau đó batch kiểm 260 SKU còn lại qua 282 request (11 non-2xx). Lý do dừng `"HTTP_403_OR_CHALLENGE"`. Crawler chạy tuần tự, cách nhau tối thiểu 1 giây, giữ checkpoint theo ID, SKU và phiên bản parser.

Quality gate #467 ở chế độ `import-review`: **0 FAIL**, 2 dòng WARN, gồm 0 dòng giá mới cần đọc cảnh báo. Dòng baseline giữ timestamp gốc và nhãn `STALE_PILOT_BASELINE_448`. Inventory đối chiếu từ bản đã chốt ở #448, sai lệch 0 dòng so với baseline. Giá và trạng thái này dùng để review. Cần làm mới giá trước cutover.

- [CSV 1.543 ngoại lệ và trạng thái crawl](recovery.csv)
- [CSV hợp nhất 2.090 SKU thiết bị vệ sinh](sanitary-merged.csv)
- [CSV trường hợp chưa có giá hoặc có cảnh báo](exceptions.csv)
- [CSV SKU gần giống cần đối chiếu](ambiguous-aliases.csv)
- [Bằng chứng từng SKU](evidence.jsonl)
- [Số request, timestamp và checksum](crawl-summary.json)
- [Kết quả quality gate](quality-gate.json)

Rollback thay đổi tooling bằng revert PR. Không phát sinh ghi Database hoặc deploy.

## Phần còn lại

Hita dừng lượt chạy lúc 05:47:32 UTC với `HTTP_403_OR_CHALLENGE`. SKU đầu tiên chưa có kết quả là `A-DV618S-15` (ID 8251). CSV gắn `NOT_CRAWLED` cho 1.195 SKU còn lại. Chỉ tiếp tục khi Hita cho phép truy cập công khai trở lại hoặc có phương thức crawl được Hita cho phép. Dùng danh sách `NOT_CRAWLED` và checkpoint phiên bản `hita-pdp-477.1` để chạy phần còn lại, sau đó chạy lại quality gate.

- Điều tra nguyên nhân và tái lập với fixture: PASS.
- Pilot độ chính xác và ngưỡng phục hồi: PASS trong mẫu 100 SKU.
- Đối soát dữ liệu, kiểm tra nguyên vẹn baseline và quality gate: PASS.
- Độ phủ crawl toàn bộ: BLOCKED tại 348/1.543, kèm checkpoint và danh sách chưa kiểm.
