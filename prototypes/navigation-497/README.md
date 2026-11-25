# Issue #497 · Design Approval

N1 và N2 sử dụng base `48cef447d5ad2b4d87f0a888f93f01babe025a8b`. Mọi file nằm trong thư mục prototype. Khi preflight, draft #496, #474 và #469 không trùng đường dẫn. Trước bàn giao, `main` của GitHub đã lên `73cef1d` sau khi #496 merge vào hai file page-cache. Base kiểm tra của prototype được giữ để tái tạo kết quả. Nhánh Claude, runtime Public, API, Listing/PDP, CI, flags và release vẫn thuộc các luồng hiện tại.

## Chạy và duyệt

Từ root worktree, với Node 24, chạy `node prototypes/navigation-497/server.mjs`, rồi mở **http://127.0.0.1:4970/**. Có thể chọn cổng khác với biến `PORT`. Để mở trên điện thoại cùng mạng với máy chạy, dùng `HOST=0.0.0.0 PORT=4970 node prototypes/navigation-497/server.mjs` rồi mở cổng 4970 trên địa chỉ LAN của máy đó. Máy và điện thoại cần ở cùng mạng cho phép kết nối cục bộ.

- **Desktop.** Mở **Sản phẩm → Thiết bị vệ sinh → INAX → Bồn cầu**. Quay lại và mở **Thương hiệu → INAX → Thiết bị vệ sinh → Bồn cầu**. Cả hai trỏ đến `/thiet-bi-ve-sinh/bon-cau?brand=inax`. Rê chuột qua Sản phẩm khoảng 300 ms, đưa chuột vào menu, sau đó dùng Tab, Enter hoặc Space và Escape. Cuộn trang để kiểm tra header thu gọn. Link Listing mở trang public thực tế.
- **Mobile.** Mở menu, thử hai luồng trên và dùng **Quay lại** giữa các cấp. Đóng menu, cuộn qua phần đầu và chạm biểu tượng tìm. Nhập `MS636DT2#XW` hoặc `bon cau 1 khoi`. Thử `zzzz497` để xem trạng thái trống. Mở giỏ, chọn **Thử với 2 sản phẩm**, xem badge và xóa lại.
- **Series.** Mở **http://127.0.0.1:4970/?layout=series** và chọn Thiết bị vệ sinh, Tất cả hoặc INAX. S600 LINE hiển thị minh họa tỷ lệ desktop 20/55/25. Thẻ ghi rõ ảnh và Listing theo dòng chưa sẵn sàng, không có link. Chuyển TOTO hoặc danh mục khác để thấy cột biến mất. Bản mặc định mở rộng cột điều hướng. [Bằng chứng chính xác theo SKU](https://github.com/tranhuunguyenhuy-hue/dongphugia-web/issues/431#issuecomment-7060330377)
- **Bản một file.** Chạy `node prototypes/navigation-497/pack.mjs /tmp/navigation-497.html`. File nhúng logo, ảnh, CSS, JavaScript và dữ liệu. Mở bằng trình duyệt cho phép JavaScript trên file local hoặc phục vụ file qua HTTP local. Nếu trình xem file trên điện thoại không chạy JavaScript, dùng bản HTTP local qua LAN. Thêm `?layout=series` vào URL để thử bố cục Series.
- **Tìm trực tiếp trên public API.** Chạy `NODE_USE_ENV_PROXY=1 PORT=4971 node prototypes/navigation-497/server.mjs --live-search` rồi mở **http://127.0.0.1:4971/**. API egress là GET tới `/api/search` hiện có. Chế độ mặc định phục vụ mẫu 65 SKU, có nhãn trong gợi ý và kết quả. Chế độ live chuyển lỗi thành thông báo và cho thử lại. Giỏ dùng **sessionStorage** riêng của prototype, không gửi yêu cầu commerce.

## N1 · Technical & Data Audit

**Phạm vi quan sát 25/11/2026.** Public `x-dpg-source-sha=e070986a19fdd579aa639524b83c3914bdc95fc1`; health báo `postgresql`. Base worktree mới hơn. Đối chiếu một mẫu hữu hạn bằng GET trên trang public và shard, kết quả ghi tại `snapshot.json`. Chỉ đưa vào fixture ID, SKU, tên, path, quan hệ và dấu giá vắng từ các phản hồi public. 17 loại, 8 hãng, 20 quan hệ có SKU xuất hiện trên Listing đúng bộ lọc, 65 SKU dùng để thử Search. Tập mẫu không đại diện toàn bộ danh mục hay độ phủ của hãng. Các link PDP lấy từ href đã xuất hiện trên Listing hoặc phản hồi Search phù hợp; chỉ một số PDP được smoke độc lập.

| Capability | Kết quả và xử lý |
| --- | --- |
| Header V1 | **PASS audit code.** `HeaderLazy` nạp `Header` global; `Header` có Products/About dropdown, logo, SearchBar và cart theo flag, mobile dùng `MobileMenuSheet` tải khi yêu cầu. Scroll V1 chủ yếu đổi style. `apps/public/app/layout.tsx` dùng canonical UI với Worker runtime riêng theo ADR 0023. |
| Taxonomy/API | **PASS mẫu, UNKNOWN projection toàn catalogue.** Shard `/api/catalogue/listings/{family}/{listing}?page=N` trả trang đã publish, không nhận brand/Series. API hiện tại không cung cấp một graph menu gọn cho mọi family × leaf × brand × Series. Tái dùng metadata root/DTO có sẵn và cache một projection khi N4 được duyệt. Không suy quan hệ từ tên hoặc chỉ lấy trang 1 để kết luận hãng vắng toàn bộ. |
| Visibility/identity | **PASS contract và mẫu.** `live-public-catalogue.ts` yêu cầu product active, publication/PDP public, active family/type; active brand là LEFT JOIN. Mỗi SKU là một card/PDP. Giá null vẫn hợp lệ, ví dụ `MS636DT2#XW`. Thiếu brand hợp lệ thì chỉ hiện trong Tất cả; thiếu family/type bị loại theo contract. **UNKNOWN** ví dụ SKU public thiếu brand trong tập kiểm tra. Có evidence lịch sử thiếu Series LABEL/option từ #431, xem dưới. |
| Listing / URL | **PASS 17 leaf và 20 cặp nonempty trong mẫu.** Leaf `/{family}/{type}?brand=x`; root `/{family}?brands=x` và không có root xuyên family theo hãng. Điều kiện convergent chia sẻ một hàm. Root vệ sinh trả HTTP 500 cả hai lần, có và không có `brands`; dùng `/danh-muc` local để chọn các leaf đã xác minh. Bồn cầu TOTO có lần đầu 500, sau đó 200 và xác nhận SKU; **FAIL ổn định live**, không khẳng định rollout đã xong. |
| Series / variant | **PASS nguồn hãng theo exact SKU, FAIL trên public facet đã thử, UNKNOWN coverage hiện hành.** #431/#432/#433/#440 là audit/pilot. `canonical-price.ts` / `live-public-catalogue.ts` gate `PUBLIC_SERIES_VARIANT` cho Production và tài liệu ghi hạn chế grant spec. `?brand=toto&dong=memory` trả 404 trên Public quan sát; “Memory” trong tên SKU là PENDING trong #431, không đủ lập Series. `AC-G216VN/BW1` được #431 xác minh INAX S600 LINE; search exact 200 nhưng PDP này trả 500 lúc probe. Theo #431, 13 SKU TOTO ZL khớp hãng nhưng thiếu nhãn DB và nhiều SKU sen/vòi thiếu label/evidence. Chỉ hiển thị thẻ S600 LINE trong layout demo, không có link. INAX Ecocarat là leaf thật, dùng đúng route leaf. |
| Search | **PASS exact SKU, tên và empty trong mẫu; FAIL ổn định toàn bộ public.** `SearchBar` / Public Worker dùng GET `/api/search?q=&limit=` và `/tim-kiem?q=`. Có 503 ở `inax` trước khi retry 200. Smoke URL kết quả tìm SKU 200 và local proxy exact + empty 200. Không suy total từ fixture. |
| Cart / commerce #470 | **PASS contract + badge local, FAIL khả dụng live lúc probe.** Header theo `PUBLIC_COMMERCE`, UI `/gio-hang` 404 trên Public đã kiểm; `dpg-cart-v2` cộng quantity và POST commerce phụ thuộc flag/binding. Prototype mô phỏng 0 và 2 sản phẩm, không đọc giỏ thật. PR #496 ghi packaged verify cả giá + commerce 503 trên base này; PR #474 ghi release readiness, #470 không phải evidence live đã bật flag. |
| Perf | **PASS local.** Thu gọn giữ nguyên tọa độ document của main. Chromium ghi CLS không do input bằng 0 cho luồng desktop/mobile đã đo. Desktop warm menu sản phẩm thêm 0 request. Lần mở Thương hiệu tải 4 logo lazy, mỗi logo một lần, tổng request 9 → 13, không gọi lại API/snapshot khi đổi lựa chọn, hover hoặc scroll. **UNKNOWN** baseline runtime live và tác động N4 vì đây là harness riêng. |

### Mẫu đối chiếu

Mỗi dòng dưới là SKU thật, kiểm qua JSON public và href của Listing đích. Đối chiếu đầy đủ 20 cặp trong `snapshot.json → verifiedRelations` gồm endpoint nguồn, ID, SKU và tình trạng giá null. Nhóm chọn hãng hội tụ với nhóm chọn loại theo cùng mapping.

| Family | Hãng | ID / SKU mẫu | Listing đích |
| --- | --- | --- | --- |
| Vệ sinh | TOTO | 676 / `MS636DT2#XW`, giá trống | `/thiet-bi-ve-sinh/bon-cau?brand=toto` |
| Vệ sinh | INAX | 249 / `AC-2700VN/BW1`, Search exact/model + href | `/thiet-bi-ve-sinh/bon-cau?brand=inax` |
| Bếp | Elica | 398 / `H7 EVCH7520BL` | `/thiet-bi-bep/bep-dien-tu?brand=elica` |
| Bếp | Kluger | 376 / `KF7848FS - S78 Plus` | `/thiet-bi-bep/chau-rua-chen?brand=kluger` |
| Nước | Karofi | 422 / `KAQ-U99` | `/vat-lieu-nuoc/loc-nuoc?brand=karofi` |
| Nước | Đại Thành | 5348 / `BNDTl1000D` | `/vat-lieu-nuoc/bon-chua-nuoc?brand=dai-thanh` |
| Gạch | INAX | 7822 / `ECP-303/RBM2N` | `/gach-op-lat/gach-inax-ecocarat?brand=inax` |

## N2 · Kiểm tra

| Kết quả | Bằng chứng |
| --- | --- |
| **PASS** | Chromium 320/375/390/430/768/1024/1280/1440 px. Header normal/compact, 1024 touch, scroll nội bộ ở viewport thấp, menu click/touch/hover grace, click ngoài, keyboard và focus restore, back/close/reopen, điều hướng về URL đã audit, reduced motion, no-Series và logo thật. |
| **PASS** | Gợi ý SKU, tên, submit, empty, loading, retry sau 503 mô phỏng, request cũ không ghi đè. Giỏ local 0 → 2 → 0, header badge khớp quantity. Server và module chạy bằng Node 24, tập test không cần khởi động Next hay database. |
| **PASS** | Bản HTML nhúng đã kiểm duyệt tương tác bằng Chromium qua HTTP tĩnh. |
| **UNKNOWN** | Safari/iOS thiết bị thật, quyền/lifestyle chính xác của Series, ảnh hưởng CLS/chi phí cho runtime Public sau N4, Search live trên toàn catalogue và commerce live. Browser kiểm tra lỗi 503 và bước điều hướng bằng intercept có chủ đích; mã HTTP public được smoke riêng. |

Chạy lại bằng Node và Playwright đã cài. Có thể dùng Chromium hệ thống qua `CHROMIUM=/usr/bin/chromium`, và đặt `PLAYWRIGHT_MODULE` tới thư mục package nếu Playwright nằm ngoài repo.

```sh
node prototypes/navigation-497/browser-check.mjs
```

Ảnh nghiệm thu đại diện nằm trong `evidence/`. Lệnh browser trên xuất thêm ảnh PNG vào `/tmp/navigation-497-evidence` hoặc đường dẫn `NAV_EVIDENCE`.

## Design Approval · Owner

1. Duyệt phân cấp **Sản phẩm / Thương hiệu**, mặc định **Tất cả**, hai đường về cùng Listing và vị trí **Xem tất cả**.
2. Duyệt visual warm neutral/đỏ rượu, Georgia cho tiêu đề và system font cho điều hướng, logo gốc, bộ line icon, kích thước header desktop 112/64 px và mobile 116/60 px, ngưỡng desktop 1024 px.
3. Duyệt vị trí logo hãng gợi ý **INAX, TOTO, Elica, Karofi** và tối đa hai ô Series khi đủ dữ liệu/ảnh/quyền. Đây là đề xuất bố cục. Series live và hãng chiến lược cần Owner xác nhận riêng.
4. Duyệt hành vi search, mobile drill-down và cart affordance. TL cần đối chiếu các lỗi live ghi trên với lane release trước N4.

Dừng tại Design Approval. Bỏ prototype bằng cách tháo worktree/nhánh sau khi hoàn tất duyệt. Không có thay đổi dữ liệu cần rollback.
