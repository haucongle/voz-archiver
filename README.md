# voz-archiver

Lưu lại thread và toàn bộ reply trên voz.vn trước khi mod xóa, chạy hoàn toàn
trên Cloudflare Workers nên không cần máy nào bật 24/7.

Cứ mỗi phút, Worker đọc danh sách thread cần tải rồi bóc thêm vài trang; năm
phút một lần nó hỏi RSS của các box bạn theo dõi để phát hiện thread mới. Khi
voz trả về 404 hoặc 403 cho một thread đã lưu, nó đánh dấu thread đó là đã bị
xóa nhưng vẫn giữ nguyên nội dung. Có giao diện web để đọc lại và tìm kiếm toàn
văn, gõ không dấu vẫn ra.

## Chạy được trên gói Free, nhưng có điều kiện

Gói Free cho **10 ms CPU mỗi lần Worker chạy**, kể cả với Cron Trigger — không
có ngoại lệ nào cho lịch chạy nền. Đây là ràng buộc chi phối toàn bộ thiết kế
bên dưới.

Chi phí parse một trang thread, đo trên 9 trang voz thật cỡ 149–281 KB:

| Cách parse | CPU mỗi trang |
|---|---|
| Chuỗi thuần (`PARSE_MODE=fast`, mặc định) | **0,5–4,3 ms**, trung vị 1,5 ms |
| HTMLRewriter, chế độ `full` | 45–204 ms |
| HTMLRewriter, chế độ `text` | ~150 ms, chỉ đo trên trang nặng nhất |
| Hạn mức gói Free | 10 ms |
| Hạn mức gói Paid | 30 s |

Chế độ `text` chỉ đo trên đúng một trang, là trang mà `full` tốn ~200 ms. Nó rẻ
hơn `full` chừng 25% vì bỏ được bước dựng lại HTML, nhưng vẫn phải trả toàn bộ
chi phí thật sự nên chưa bao giờ là lối thoát.

Chênh lệch 30–140 lần này không đến từ việc tokenize HTML. Nó đến từ selector
`article[data-content^="post-"] *` trong bản HTMLRewriter: dấu `*` khớp mọi
element bên trong mọi bài, và một trang XenForo có hàng nghìn element, nghĩa là
hàng nghìn lần gọi callback JS qua lại biên Rust. Bản thân bộ tokenize viết
bằng Rust chạy 218 KB chưa tới 1 ms. Bỏ hết số lần vượt biên đó đi thì chi phí
sụp xuống một bậc, và gói Free đủ dùng.

Ba cái trần cần để mắt, xếp theo mức độ khó chịu tăng dần:

**CPU, 10 ms mỗi lượt.** Đã xử lý. `MAX_PAGES_PER_RUN=2` vì hai trang xấu nhất
liên tiếp là 8,6 ms, còn ba trang thì thành 12,9 ms và Worker bị cắt với lỗi
1102.

**Subrequest, 50 mỗi lượt.** Truy vấn D1 cũng tính vào đây chứ không riêng
`fetch` ra ngoài — tài liệu D1 ghi thẳng "queries per Worker invocation: 50
(Free)". Mỗi trang tốn 4 (một fetch cộng ba truy vấn D1), cộng 7 cố định cho
RSS và sổ nhật ký, nên trần thật là khoảng 9 trang mỗi lượt. Cao hơn mức CPU
cho phép nên không vướng.

**Ghi D1, 100 nghìn dòng mỗi ngày.** Đây mới là chỗ căng. Chạy hết công suất
2.880 trang/ngày, mỗi trang 20 bài, mỗi bài kéo theo 1–2 dòng nữa cho chỉ mục
FTS, ước tính rơi vào khoảng 150 nghìn dòng ghi mỗi ngày. Vượt trần, và khi
vượt thì D1 trả lỗi cho tới 00:00 UTC hôm sau. Cách chữa gọn nhất là sửa
`savePage` để bỏ qua những bài đã lưu mà nội dung không đổi, vì phần lớn lượt
tải lại trang cuối chỉ thêm được vài bài mới; hiện chưa làm. Cách chữa lười hơn
là bớt box theo dõi hoặc giãn cron.

Nếu không muốn bận tâm mấy chuyện trên thì gói Paid 5 USD/tháng nâng CPU lên
30 giây, subrequest lên 10 nghìn, và ghi D1 lên 50 triệu dòng/tháng. Lúc đó cứ
để `MAX_PAGES_PER_RUN` vài trăm và quên nó đi.

## Cài đặt

```bash
npm install

# 1. Tạo database rồi dán id nhận được vào wrangler.jsonc
npx wrangler d1 create voz-archive

# 2. Dựng bảng
npm run db:init

# 3. Đặt mật khẩu cho giao diện web
npx wrangler secret put ARCHIVE_KEY

# 4. Đẩy lên
npm run deploy
```

Mở `https://voz-archiver.<tên-tài-khoản>.workers.dev/?key=<ARCHIVE_KEY>`.
Lần đầu vào, key được lưu vào cookie nên các lần sau khỏi cần gõ.

Chạy thử tại máy trước khi deploy:

```bash
npm run db:init:local
echo "ARCHIVE_KEY=dev-local-key" > .dev.vars
npm run dev
# rồi mở http://127.0.0.1:8787/run?key=dev-local-key
```

Sau khi deploy, `observability` đã bật sẵn nên vào Workers Logs xem `cpuTime`
thật của vài chục lượt đầu rồi chỉnh `MAX_PAGES_PER_RUN` theo đó. Số đo dưới
`wrangler dev` chỉ để so sánh tương đối giữa hai parser, không phải số của máy
biên Cloudflare.

## Chọn box theo dõi

Sửa mảng `FORUMS` trong `src/config.ts`. Lấy id bằng cách mở box trên voz và
nhìn con số sau dấu chấm trong URL, ví dụ `/f/diem-bao.33/` thì id là 33. Phần
chữ không quan trọng vì XenForo chỉ đọc số.

## Các nút vặn trong `wrangler.jsonc`

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `MAX_SUBREQUESTS` | 45 | Trần request mỗi lượt, gồm cả truy vấn D1 |
| `MAX_PAGES_PER_RUN` | 2 | Trần trang parse mỗi lượt, đây là van CPU |
| `MAX_PAGES_PER_THREAD` | 2 | Chặn một thread khổng lồ nuốt hết ngân sách |
| `MAX_NEW_THREADS` | 2 | Trần thread mới xử lý mỗi lượt |
| `ACTIVE_WINDOW_HOURS` | 72 | Quá hạn này thì thôi theo dõi reply mới |
| `RSS_EVERY_MINUTES` | 5 | Cron chạy mỗi phút, RSS chỉ hỏi ngần này phút một lần |
| `PARSE_MODE` | `fast` | `full` và `text` là hai chế độ HTMLRewriter cũ |

## Hai parser, và vì sao giữ cả hai

`src/voz-fast.ts` là parser đang chạy. `src/voz.ts` giữ bản HTMLRewriter cũ,
không phải vì còn dùng mà vì nó là bản tham chiếu để đối chiếu.

`/bench?id=<thread>&slug=<slug>&page=1&n=10` chạy cả hai trên cùng một trang,
đo CPU qua nhiều vòng, rồi so từng trường một: id, tác giả, thời điểm, số thứ
tự, nội dung text đã chuẩn hóa khoảng trắng. Nó còn đếm sáu dấu hiệu hỏng trong
HTML đã bóc — ảnh còn trỏ vào placeholder, URL còn tương đối, thẻ script sót
lại — và tất cả phải bằng 0.

Đối chiếu trên 9 trang cho 8 trang khớp tuyệt đối. Trang còn lại lệch đúng hai
chỗ, và cả hai đều là bản cũ sai: `data-author` không được giải mã entity nên
ra `ghostsilver&#039;`, và thiếu xuống dòng sau `</li>` nên hai khối chữ dính
thành "phẩmCông" khiến tìm kiếm trượt cả hai từ. Hai lỗi này cố tình để nguyên
trong bản cũ; vá đi thì mất luôn bằng chứng.

## Vài con số đo được

Feed RSS của box Chuyện trò linh tinh chứa 20 item và trải dài khoảng **51
phút**. Đó là cửa sổ để bắt kịp thread mới, và cũng là lý do RSS chỉ cần hỏi 5
phút một lần dù cron chạy mỗi phút. Cron dày lên không phải để phát hiện nhanh
hơn mà để gom đủ lượt parse trong hạn mức CPU: lịch 5 phút cho 288 lượt/ngày,
nhân 2 trang là 576, không đủ so với khoảng 1.130 trang/ngày mà riêng box đông
nhất cần cho thread mới. Lịch 1 phút cho 1.440 lượt, tức 2.880 trang/ngày.

Kho lưu tốn khoảng **2,9 KB mỗi bài** kể cả chỉ mục tìm kiếm, đo trên 307 bài
thật. Gói Free giới hạn **500 MB mỗi database** — con số 5 GB hay gặp là hạn
mức của cả tài khoản, không phải của một database — nên trần thật là khoảng
**172 nghìn bài**. Gói Paid cho 10 GB mỗi database.

## Chiến lược tải trang

Thread mới gặp lần đầu chưa chắc là thread mới tinh, rất có thể là thread từ
nhiều năm trước vừa bị đào lên và có hàng nghìn trang. Bò tuần tự từ trang 1 sẽ
đốt sạch ngân sách vào nội dung cổ trong khi phần đang bàn nằm ở trang cuối.

Nên archiver lấy trang 1 để có bài mở đầu, rồi nhảy thẳng tới trang cuối, và
**cố ý bỏ qua phần giữa**. Từ đó về sau nó đi tiếp theo các trang mới sinh ra.
Mục tiêu là giữ những gì sắp bị xóa, không phải chép lại toàn bộ lịch sử diễn
đàn. Muốn backfill đầy đủ thì phải sửa `src/crawler.ts`.

## Những chỗ đã sập bẫy

Ghi lại để ai đọc code sau khỏi tưởng là code thừa.

voz chèn quảng cáo bằng `<div class="message message--post">`, trùng class với
bài viết thật. Phải bám vào `article` kèm `data-content="post-..."`.

**Không có gì tự giải mã entity HTML cho bạn.** HTMLRewriter thì không giải mã
cả text lẫn giá trị thuộc tính; parser chuỗi thì càng không, vì nó chỉ cắt
chuỗi. Chỗ này đã bị quên ba lần ở ba nơi khác nhau: `data-author` trong bản
cũ, tiêu đề `<h1>` trong bản mới, và giá trị thuộc tính trong `serializeStartTag`
mà nếu bỏ qua thì URL ảnh `proxy.php?image=...&amp;hash=...` bị escape thành
`&amp;amp;` và voz trả về ảnh báo lỗi. Cứ chỗ nào lôi chữ ra khỏi HTML là phải
tự nhớ giải mã.

Parser chuỗi né được một nửa vấn đề vì nó giữ nguyên HTML thay vì dựng lại:
trình duyệt tự hiểu `&#039;`, nên không cần giải mã rồi escape lại. Chỉ những
gì bóc ra thành chữ thuần — tiêu đề, tên tác giả, phần text cho FTS — mới cần.

Ảnh dùng lazy-load nên `src` chỉ là placeholder SVG, URL thật nằm ở `data-src`.

Quote lồng nhau cũng chứa `.bbWrapper`, nên phải đếm độ sâu `<div>` chứ không
thể cắt tới `</div>` đầu tiên.

Khi bóc text cho FTS, phải chèn xuống dòng ở cả `</li>`, `</tr>` và `</h*>`
chứ không chỉ `</p>` với `</div>`. Thiếu chúng thì hai khối chữ dính liền thành
một từ không ai tìm ra được.

## Giới hạn cần biết

Ảnh vẫn là link trỏ về server voz. Chữ thì an toàn vĩnh viễn nhưng ảnh sẽ chết
khi voz xóa file gốc. Muốn giữ thật thì phải tải bytes về R2, hiện chưa làm.

Thread bị xóa trong vòng dưới một phút kể từ lúc lập vẫn có thể lọt lưới, và
thực tế cửa sổ rộng hơn thế vì RSS chỉ hỏi 5 phút một lần.

Chỉ phát hiện được bài bị xóa lẻ trên những trang mà archiver có ghé lại. Phần
giữa của thread dài không được theo dõi.

## Lịch sự với voz

`robots.txt` của voz cho phép crawl (`Allow: /`, chỉ chặn `/admin.php` và một số
bot AI có tên cụ thể). Mặc định archiver nghỉ 700 ms giữa hai request và chỉ
lấy 2 trang mỗi phút, tức tải nhẹ hơn một người đang lướt web bình thường. Đừng
hạ con số 700 ms đó, và đừng bỏ `RSS_EVERY_MINUTES` để hỏi feed mỗi phút — cửa
sổ feed là 51 phút nên làm vậy chẳng được gì.

voz cũng đặt `Content-Signal: ai-train=no, use=reference`. Đọc và lưu trữ cá
nhân nằm trong phạm vi cho phép, nhưng đừng đem kho này đi train model hay
đăng lại công khai. Giao diện web đã đặt `noindex` và bắt buộc có key, cứ để vậy.
