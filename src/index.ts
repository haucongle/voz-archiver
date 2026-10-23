import { runCrawl, type CrawlOptions, type CrawlStats } from "./crawler";
import { numVar, type Env } from "./env";
import * as store from "./store";
import { escapeHtml, fmtAgo, fmtTime, layout } from "./ui";
import { parseThreadPage, threadUrl, type ParsedThreadPage } from "./voz";
import { parseThreadPageFast } from "./voz-fast";
import { USER_AGENT } from "./config";

export default {
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    // RSS không cần hỏi dày như nhịp cron: cửa sổ feed của box đông nhất là
    // ~51 phút, nên vài phút một lần đã dư biên, và hỏi mỗi lượt chỉ tổ làm
    // phiền voz. Chia theo mốc thời gian nên không cần lưu trạng thái.
    // Cron chỉ chạy ở những phút cách nhau `cronMinutes`, nên "trúng mốc" là
    // dư của phép chia nằm trong khoảng [0, cronMinutes). CRON_EVERY_MINUTES
    // phải khớp lịch cron thật: cron mỗi giờ mà để 2 thì phút :02 luôn có dư
    // 2 và RSS bị bỏ qua vĩnh viễn, còn đặt 60 thì RSS chạy ở mọi lượt.
    const everyMinutes = numVar(env.RSS_EVERY_MINUTES, 5);
    const cronMinutes = numVar(env.CRON_EVERY_MINUTES, 2);
    const minute = Math.floor(event.scheduledTime / 60_000);
    await crawlAndLog(env, { skipRss: minute % everyMinutes >= cronMinutes });

    try {
      const pruned = await store.pruneOldPosts(
        env.DB,
        numVar(env.PRUNE_AFTER_DAYS, 14),
        numVar(env.PRUNE_POSTS_PER_RUN, 15),
      );
      if (pruned.posts || pruned.threads) console.log("prune", JSON.stringify(pruned));
    } catch (e) {
      console.error("prune lỗi", e instanceof Error ? e.message : String(e));
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const auth = authorize(req, env);

    if (!auth.ok) {
      return new Response(
        env.ARCHIVE_KEY
          ? "Thiếu hoặc sai key. Thêm ?key=... vào URL.\n"
          : "Chưa đặt secret ARCHIVE_KEY. Chạy: npx wrangler secret put ARCHIVE_KEY\n",
        { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    let res: Response;
    try {
      res = await route(url, env, auth.key);
    } catch (e) {
      const msg = e instanceof Error ? `${e.message}\n\n${e.stack ?? ""}` : String(e);
      res = new Response(msg, { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (auth.setCookie) {
      res = new Response(res.body, res);
      res.headers.append("set-cookie", auth.setCookie);
    }
    return res;
  },
} satisfies ExportedHandler<Env>;

/* ------------------------------------------------------------------ auth */

function authorize(req: Request, env: Env): { ok: boolean; key: string; setCookie?: string } {
  const secret = env.ARCHIVE_KEY;
  if (!secret) return { ok: false, key: "" };

  const fromQuery = new URL(req.url).searchParams.get("key");
  const cookieMatch = (req.headers.get("cookie") || "").match(/(?:^|;\s*)vozkey=([^;]+)/);
  const given = fromQuery ?? (cookieMatch ? decodeURIComponent(cookieMatch[1]) : null);

  if (!given || !constantTimeEqual(given, secret)) return { ok: false, key: "" };

  return {
    ok: true,
    key: secret,
    setCookie: fromQuery
      ? `vozkey=${encodeURIComponent(secret)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`
      : undefined,
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* --------------------------------------------------------------- routing */

async function route(url: URL, env: Env, key: string): Promise<Response> {
  const threadMatch = url.pathname.match(/^\/t\/(\d+)\/?$/);
  if (threadMatch) return threadView(env, key, Number(threadMatch[1]));

  switch (url.pathname) {
    case "/":
      return listView(env, key, url.searchParams.get("q") ?? "", url.searchParams.get("gone") === "1");
    case "/status":
      return statusView(env, key);
    case "/run":
      return runView(env, key);
    case "/prune":
      return pruneView(env, key, url);
    case "/bench":
      return benchView(env, key, url);
    default:
      return new Response("Không có trang này", { status: 404 });
  }
}

/* ----------------------------------------------------------------- views */

interface ThreadListRow {
  id: number;
  title: string;
  forum_name: string | null;
  author: string | null;
  last_activity: number | null;
  first_seen: number;
  post_count: number;
  gone_at: number | null;
}

async function listView(env: Env, key: string, q: string, goneOnly: boolean): Promise<Response> {
  const k = encodeURIComponent(key);
  const searchBox = `
<form class="search" method="get" action="/">
  <input type="hidden" name="key" value="${escapeHtml(key)}">
  ${goneOnly ? '<input type="hidden" name="gone" value="1">' : ""}
  <input type="search" name="q" placeholder="Tìm trong nội dung bài (gõ không dấu cũng được)" value="${escapeHtml(q)}">
  <button type="submit">Tìm</button>
</form>`;

  if (q.trim()) return layout("Tìm kiếm", key, searchBox + (await searchResults(env, key, q)));

  const sql = goneOnly
    ? `SELECT id,title,forum_name,author,last_activity,first_seen,post_count,gone_at
         FROM threads WHERE gone_at IS NOT NULL ORDER BY gone_at DESC LIMIT 200`
    : `SELECT id,title,forum_name,author,last_activity,first_seen,post_count,gone_at
         FROM threads ORDER BY COALESCE(last_activity, first_seen) DESC LIMIT 200`;

  const { results } = await env.DB.prepare(sql).all<ThreadListRow>();
  const rows = results ?? [];

  if (rows.length === 0) {
    return layout("Kho lưu voz", key, searchBox +
      `<p class="empty">Chưa có gì trong kho.<br><a href="/run?key=${k}">Chạy thử một lượt thu thập</a></p>`);
  }

  const items = rows
    .map((t) => {
      const badge = t.gone_at
        ? `<span class="badge gone">đã xóa ${fmtAgo(t.gone_at)}</span>`
        : `<span class="badge live">còn sống</span>`;
      return `<li>
  <div class="title"><a href="/t/${t.id}?key=${k}">${escapeHtml(t.title)}</a>${badge}</div>
  <div class="muted">${escapeHtml(t.author ?? "?")} · ${escapeHtml(t.forum_name ?? "")} · ${t.post_count} bài · hoạt động ${fmtAgo(t.last_activity ?? t.first_seen)}</div>
</li>`;
    })
    .join("\n");

  return layout(goneOnly ? "Thread đã bị xóa" : "Kho lưu voz", key,
    searchBox + `<ul class="threads">${items}</ul>`);
}

async function searchResults(env: Env, key: string, q: string): Promise<string> {
  const k = encodeURIComponent(key);
  // Bọc thành cụm từ để ký tự đặc biệt không làm hỏng cú pháp FTS5.
  const phrase = `"${q.trim().replace(/"/g, '""')}"`;

  const { results } = await env.DB.prepare(
    `SELECT p.id, p.thread_id, p.author, p.posted_at, p.gone_at,
            t.title, t.gone_at AS thread_gone,
            snippet(posts_fts, 0, '@@HL@@', '@@/HL@@', '…', 24) AS snip
       FROM posts_fts
       JOIN posts   p ON p.id = posts_fts.rowid
       JOIN threads t ON t.id = p.thread_id
      WHERE posts_fts MATCH ?1
      ORDER BY rank
      LIMIT 60`,
  )
    .bind(phrase)
    .all<{
      id: number; thread_id: number; author: string | null; posted_at: number | null;
      gone_at: number | null; title: string; thread_gone: number | null; snip: string;
    }>();

  const rows = results ?? [];
  if (rows.length === 0) return `<p class="empty">Không tìm thấy bài nào khớp.</p>`;

  const items = rows
    .map((r) => {
      // snippet() trả về text thô, phải escape rồi mới đổi sentinel thành <mark>.
      const snip = escapeHtml(r.snip)
        .replaceAll("@@HL@@", "<mark>")
        .replaceAll("@@/HL@@", "</mark>");
      const gone = r.gone_at || r.thread_gone ? `<span class="badge gone">đã xóa</span>` : "";
      return `<li>
  <div class="title"><a href="/t/${r.thread_id}?key=${k}#p${r.id}">${escapeHtml(r.title)}</a>${gone}</div>
  <div class="muted">${escapeHtml(r.author ?? "?")} · ${fmtTime(r.posted_at)}</div>
  <div class="content">${snip}</div>
</li>`;
    })
    .join("\n");

  return `<p class="muted">${rows.length} kết quả</p><ul class="threads">${items}</ul>`;
}

async function threadView(env: Env, key: string, id: number): Promise<Response> {
  const thread = await env.DB.prepare(`SELECT * FROM threads WHERE id = ?1`)
    .bind(id)
    .first<store.ThreadRow>();
  if (!thread) return new Response("Không có thread này trong kho", { status: 404 });

  const { results } = await env.DB.prepare(
    `SELECT id, author, posted_at, position, html, gone_at
       FROM posts WHERE thread_id = ?1
      ORDER BY COALESCE(posted_at, 0), id`,
  )
    .bind(id)
    .all<{
      id: number; author: string | null; posted_at: number | null;
      position: number | null; html: string | null; gone_at: number | null;
    }>();

  const posts = results ?? [];
  const status = thread.gone_at
    ? `<span class="badge gone">đã bị xóa ${fmtTime(thread.gone_at)} (HTTP ${thread.gone_status})</span>`
    : `<span class="badge live">còn sống</span>`;

  const body = posts
    .map(
      (p) => `<article class="post${p.gone_at ? " gone" : ""}" id="p${p.id}">
  <div class="meta">
    <span class="who">${escapeHtml(p.author ?? "?")}</span>
    <span>${fmtTime(p.posted_at)}</span>
    ${p.position ? `<span>#${p.position}</span>` : ""}
    ${p.gone_at ? `<span class="badge gone">bài này đã bị xóa</span>` : ""}
  </div>
  <div class="content">${p.html ?? ""}</div>
</article>`,
    )
    .join("\n");

  const header = `
<h2 style="font-size:19px;margin:0 0 6px">${escapeHtml(thread.title)} ${status}</h2>
<p class="muted" style="margin:0 0 20px">
  ${escapeHtml(thread.forum_name ?? "")} · ${posts.length} bài đã lưu · lần cuối kiểm tra ${fmtAgo(thread.last_crawled)}
  · <a href="https://voz.vn/t/${thread.slug}.${thread.id}/" rel="noreferrer noopener" target="_blank">mở trên voz</a>
</p>`;

  return layout(thread.title, key, header + (body || `<p class="empty">Chưa lưu được bài nào.</p>`));
}

async function statusView(env: Env, key: string): Promise<Response> {
  const k = encodeURIComponent(key);
  // COUNT(*) FROM posts quét hết ~200 nghìn dòng mỗi lần mở trang (D1 tính
  // từng dòng quét), mở vài chục lần là cạn hạn mức đọc 5 triệu/ngày. Nên
  // đếm bài bằng SUM(post_count) trên bảng threads (vài nghìn dòng); con số
  // này lệch nhẹ so với thực tế vì post_count chỉ cập nhật khi crawl xong.
  const counts = await env.DB.prepare(
    `SELECT COUNT(*)                                        AS threads,
            COUNT(gone_at)                                  AS threads_gone,
            COALESCE(SUM(post_count), 0)                    AS posts,
            COALESCE(SUM(pages_seen < page_count), 0)       AS backlog,
            (SELECT COUNT(*) FROM posts WHERE gone_at IS NOT NULL) AS posts_gone
       FROM threads`,
  ).first<Record<string, number>>();

  const { results: runs } = await env.DB.prepare(
    `SELECT * FROM runs ORDER BY started_at DESC LIMIT 12`,
  ).all<{
    started_at: number; finished_at: number | null; fetches: number;
    new_threads: number; new_posts: number; gone_found: number; error: string | null;
  }>();

  const runRows = (runs ?? [])
    .map(
      (r) => `<tr>
  <td>${fmtTime(r.started_at)}</td>
  <td>${r.finished_at ? "xong" : "chưa xong"}</td>
  <td>${r.fetches} request</td>
  <td>+${r.new_threads} thread, +${r.new_posts} bài</td>
  <td>${r.gone_found ? `${r.gone_found} bị xóa` : ""}</td>
  <td style="color:#ff8a95">${escapeHtml(r.error ?? "")}</td>
</tr>`,
    )
    .join("\n");

  return layout("Tình trạng", key, `
<table class="stats">
  <tr><td>Thread đã lưu</td><td>${counts?.threads ?? 0}</td></tr>
  <tr><td>Thread đã bị xóa trên voz</td><td>${counts?.threads_gone ?? 0}</td></tr>
  <tr><td>Bài đã lưu</td><td>${counts?.posts ?? 0}</td></tr>
  <tr><td>Bài bị xóa lẻ</td><td>${counts?.posts_gone ?? 0}</td></tr>
  <tr><td>Thread còn trang chưa tải</td><td>${counts?.backlog ?? 0}</td></tr>
</table>
<p style="margin-top:22px"><a href="/run?key=${k}">Chạy một lượt thu thập ngay</a></p>
<h3 style="font-size:15px;margin:26px 0 8px">Các lượt gần đây</h3>
<table class="stats">${runRows || "<tr><td>Chưa chạy lần nào</td></tr>"}</table>`);
}

async function runView(env: Env, key: string): Promise<Response> {
  const stats = await crawlAndLog(env);
  const k = encodeURIComponent(key);
  return layout("Đã chạy", key, `
<table class="stats">
  <tr><td>Request đã gửi</td><td>${stats.fetches}</td></tr>
  <tr><td>Trang thread đã parse</td><td>${stats.pages}</td></tr>
  <tr><td>Thread mới</td><td>${stats.newThreads}</td></tr>
  <tr><td>Bài mới</td><td>${stats.newPosts}</td></tr>
  <tr><td>Bài ghi lại vì nội dung đổi</td><td>${stats.rewritten}</td></tr>
  <tr><td>Bài bỏ qua vì y nguyên</td><td>${stats.skipped}</td></tr>
  <tr><td>Phát hiện bị xóa</td><td>${stats.goneFound}</td></tr>
</table>
${stats.notes.length ? `<h3 style="font-size:15px;margin:22px 0 8px">Ghi chú</h3><ul class="muted">${stats.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>` : ""}
<p style="margin-top:22px"><a href="/?key=${k}">Về danh sách</a></p>`);
}

/**
 * Dọn tay một lô, dùng cho lần dọn đầu khi kho đã quá tải. Không tự lặp: mỗi
 * lần gọi chỉ xóa `n` bài rồi báo số dòng ghi, để người chạy tự canh hạn mức
 * 100k dòng/ngày của D1.
 *
 * Tham số: ?n=500 &days=14 &shrink=1 (đặt html về NULL trước, khi DB đã đầy)
 */
async function pruneView(env: Env, key: string, url: URL): Promise<Response> {
  const n = Math.min(5000, Math.max(1, Number(url.searchParams.get("n")) || 200));
  const days = Math.max(1, Number(url.searchParams.get("days")) || numVar(env.PRUNE_AFTER_DAYS, 14));
  const shrink = url.searchParams.get("shrink") === "1";
  const k = encodeURIComponent(key);

  const r = await store.pruneOldPosts(env.DB, days, n, shrink);
  const again = `/prune?key=${k}&n=${n}&days=${days}${shrink ? "&shrink=1" : ""}`;

  return layout("Dọn kho", key, `
<table class="stats">
  <tr><td>Giữ thread còn sống trong</td><td>${days} ngày</td></tr>
  <tr><td>Bài đã xóa</td><td>${r.posts}</td></tr>
  <tr><td>Thread đã xóa</td><td>${r.threads}</td></tr>
  <tr><td>Dòng D1 đã ghi</td><td>${r.rowsWritten}</td></tr>
</table>
<p class="muted">${r.posts === 0 ? "Không còn gì để dọn." : "Còn thì bấm lại để dọn lô tiếp."}</p>
<p style="margin-top:22px"><a href="${again}">Dọn lô tiếp</a> · <a href="/status?key=${k}">Tình trạng</a></p>`);
}

/**
 * Đo chi phí parse một trang thật và đối chiếu parser chuỗi với parser
 * HTMLRewriter. Nhanh mà bóc sai thì vô dụng, nên phép đo nào cũng phải đi
 * kèm phần so kết quả.
 *
 * Chạy dưới `wrangler dev` mới ra số thật, vì trên production Cloudflare đóng
 * băng Date.now() giữa hai lần I/O. Số đo local chỉ mang tính so sánh tương
 * đối giữa các parser; con số có thẩm quyền là `cpuTime` trong Workers Logs.
 *
 * Tham số: ?id=&slug=&page=1&n=10&only=full|text|fast|all
 */
async function benchView(env: Env, key: string, url: URL): Promise<Response> {
  const id = Number(url.searchParams.get("id"));
  if (!Number.isSafeInteger(id) || id <= 0) {
    return new Response(
      "Cần ?id=<thread id>&slug=<slug>. Tùy chọn: &page=N &n=<số vòng> &only=full|text|fast\n",
      { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const slug = url.searchParams.get("slug") || "x";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const runs = Math.min(50, Math.max(1, Number(url.searchParams.get("n")) || 10));
  const only = url.searchParams.get("only") ?? "all";
  const want = (mode: string) => only === "all" || only === mode;

  const target = threadUrl(id, slug, page);
  const net0 = Date.now();
  const res = await fetch(target, { headers: { "User-Agent": USER_AGENT } });
  // Nạp hết body vào bộ nhớ trước, để phép đo dưới đây không lẫn thời gian
  // chờ mạng mà chỉ còn đúng phần CPU bỏ ra để parse.
  const buf = await res.arrayBuffer();
  const netMs = Date.now() - net0;

  const mk = () =>
    new Response(buf, { headers: { "content-type": "text/html; charset=utf-8" } });
  const decoder = new TextDecoder();

  // Parser chuỗi nhận string, nên chi phí giải mã UTF-8 là của nó và phải
  // tính vào tổng. Bản HTMLRewriter giải mã ngầm bên trong luồng.
  let html = decoder.decode(buf);
  const dec0 = Date.now();
  for (let i = 0; i < runs; i++) html = decoder.decode(buf);
  const decodeMs = (Date.now() - dec0) / runs;

  let full: ParsedThreadPage | null = null;
  let fullMs = 0;
  if (want("full")) {
    full = await parseThreadPage(mk(), "full");
    const t = Date.now();
    for (let i = 0; i < runs; i++) full = await parseThreadPage(mk(), "full");
    fullMs = (Date.now() - t) / runs;
  }

  let text: ParsedThreadPage | null = null;
  let textMs = 0;
  if (want("text")) {
    text = await parseThreadPage(mk(), "text");
    const t = Date.now();
    for (let i = 0; i < runs; i++) text = await parseThreadPage(mk(), "text");
    textMs = (Date.now() - t) / runs;
  }

  let fast: ParsedThreadPage | null = null;
  let fastMs = 0;
  if (want("fast")) {
    fast = parseThreadPageFast(html);
    const t = Date.now();
    for (let i = 0; i < runs; i++) fast = parseThreadPageFast(html);
    fastMs = (Date.now() - t) / runs;
  }

  const kb = buf.byteLength / 1024;
  const budget = (ms: number) =>
    ms <= 0 ? "—" : `${(10 / ms).toFixed(1)} trang / 10 ms`;

  const rows = [
    ["URL", escapeHtml(target)],
    ["HTTP", String(res.status)],
    ["Kích thước trang", `${kb.toFixed(0)} KB`],
    ["Tải về (mạng, không tính vào CPU)", `${netMs} ms`],
    ["Số vòng đo", String(runs)],
    ["Giải mã UTF-8", `${decodeMs.toFixed(2)} ms`],
  ];

  if (full) {
    rows.push(["<strong>HTMLRewriter · full</strong>",
      `<strong>${fullMs.toFixed(2)} ms</strong> · ${budget(fullMs)}`]);
  }
  if (text) {
    rows.push(["<strong>HTMLRewriter · text</strong>",
      `<strong>${textMs.toFixed(2)} ms</strong> · ${budget(textMs)}`]);
  }
  if (fast) {
    const total = fastMs + decodeMs;
    rows.push(["<strong>Chuỗi thuần · parse</strong>", `<strong>${fastMs.toFixed(2)} ms</strong>`]);
    rows.push(["<strong>Chuỗi thuần · tổng (kèm giải mã)</strong>",
      `<strong>${total.toFixed(2)} ms</strong> · ${budget(total)}`]);
    if (full && fullMs > 0) {
      rows.push(["Nhanh hơn bản full", `${(fullMs / total).toFixed(1)} lần`]);
    }
  }

  const shape = full ?? text ?? fast;
  if (shape) {
    rows.push(["Số bài bóc được", String(shape.posts.length)]);
    rows.push(["Tổng số trang", String(shape.pageCount)]);
    rows.push(["Tiêu đề", escapeHtml(shape.title)]);
  }

  const table = `<table class="stats">${rows
    .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
    .join("")}</table>`;

  let diffBlock = "";
  if (full && fast) {
    const diffs = diffParsers(full, fast);
    diffBlock = diffs.length === 0
      ? `<p style="color:#7ddc9a;margin-top:22px">Hai parser cho kết quả trùng khớp trên mọi trường
         (id, tác giả, thời điểm, số thứ tự, nội dung text).</p>`
      : `<h3 style="font-size:15px;margin:26px 0 8px">Khác biệt so với parser cũ (${diffs.length})</h3>
         <ul class="muted">${diffs.map((d) => `<li><pre style="white-space:pre-wrap;margin:0">${escapeHtml(d)}</pre></li>`).join("")}</ul>`;
  }

  const sample = fast?.posts[0] ?? full?.posts[0];
  const sampleBlock = sample
    ? `<h3 style="font-size:15px;margin:26px 0 8px">Bài đầu tiên (#${sample.id})</h3>
       <table class="stats">
         <tr><td>HTML</td><td>${sample.html.length} ký tự</td></tr>
         <tr><td>Text</td><td>${sample.body.length} ký tự</td></tr>
         <tr><td>Trích text</td><td>${escapeHtml(sample.body.slice(0, 240))}</td></tr>
       </table>`
    : "";

  return layout("Đo hiệu năng", key, table + healthBlock(full, fast) + diffBlock + sampleBlock);
}

/**
 * Soi chất lượng HTML đã lưu. So số lượng trực tiếp không có nhiều ý nghĩa vì
 * hai parser dựng HTML theo hai cách khác nhau; cái đáng nhìn là các con số
 * phải bằng 0, tức những cạm bẫy trong README đã được xử lý.
 */
function healthBlock(full: ParsedThreadPage | null, fast: ParsedThreadPage | null): string {
  const probes: Array<[string, RegExp, "phải bằng 0" | ""]> = [
    ["img còn trỏ vào placeholder data:", /<img[^>]*\ssrc="data:/g, "phải bằng 0"],
    ["img thiếu hẳn thuộc tính src", /<img(?:(?!\ssrc=)[^>])*>/g, "phải bằng 0"],
    ["còn sót src tương đối", /\ssrc="\//g, "phải bằng 0"],
    ["còn sót href tương đối", /\shref="\//g, "phải bằng 0"],
    ["còn sót thẻ script", /<script\b/g, "phải bằng 0"],
    ["còn sót &amp;amp; (URL ảnh proxy hỏng)", /&amp;amp;/g, "phải bằng 0"],
    ["thẻ img giữ được", /<img\b/g, ""],
    ["quote giữ được", /<blockquote\b/g, ""],
    ["data-src thừa còn lại (vô hại)", /\sdata-src=/g, ""],
  ];

  const count = (p: ParsedThreadPage | null, re: RegExp) =>
    p === null ? "—" : String(p.posts.reduce((n, x) => n + (x.html.match(re)?.length ?? 0), 0));

  const rows = probes
    .map(([label, re, expect]) =>
      `<tr><td>${label}${expect ? ` <span class="muted">(${expect})</span>` : ""}</td>` +
      `<td>cũ ${count(full, re)} · mới ${count(fast, re)}</td></tr>`)
    .join("");

  const firstImg = (p: ParsedThreadPage | null) => {
    if (!p) return "—";
    for (const post of p.posts) {
      const m = post.html.match(/<img\b[^>]*>/);
      if (m) return escapeHtml(m[0].slice(0, 300));
    }
    return "không có ảnh nào";
  };

  return `<h3 style="font-size:15px;margin:26px 0 8px">Chất lượng HTML đã bóc</h3>
          <table class="stats">${rows}
            <tr><td>Thẻ img đầu tiên, parser cũ</td><td><code>${firstImg(full)}</code></td></tr>
            <tr><td>Thẻ img đầu tiên, parser mới</td><td><code>${firstImg(fast)}</code></td></tr>
          </table>`;
}

/**
 * So hai kết quả parse. HTML không so trực tiếp được vì bản chuỗi cố tình giữ
 * nguyên entity thay vì giải mã rồi escape lại, nên chỉ so phần text đã chuẩn
 * hóa khoảng trắng cùng các trường siêu dữ liệu.
 */
function diffParsers(oldOne: ParsedThreadPage, newOne: ParsedThreadPage): string[] {
  const out: string[] = [];
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();

  if (oldOne.title !== newOne.title) {
    out.push(`tiêu đề: cũ "${oldOne.title}" ≠ mới "${newOne.title}"`);
  }
  if (oldOne.pageCount !== newOne.pageCount) {
    out.push(`tổng số trang: cũ ${oldOne.pageCount} ≠ mới ${newOne.pageCount}`);
  }
  if (oldOne.posts.length !== newOne.posts.length) {
    out.push(`số bài: cũ ${oldOne.posts.length} ≠ mới ${newOne.posts.length}`);
  }

  const n = Math.min(oldOne.posts.length, newOne.posts.length);
  let textDrift = 0;

  for (let i = 0; i < n; i++) {
    const a = oldOne.posts[i];
    const b = newOne.posts[i];

    if (a.id !== b.id) {
      out.push(`vị trí ${i}: id lệch, cũ ${a.id} ≠ mới ${b.id} — dừng so phần còn lại`);
      break;
    }
    if (a.author !== b.author) out.push(`bài #${a.id}: tác giả "${a.author}" ≠ "${b.author}"`);
    if (a.postedAt !== b.postedAt) out.push(`bài #${a.id}: thời điểm ${a.postedAt} ≠ ${b.postedAt}`);
    if (a.position !== b.position) out.push(`bài #${a.id}: số thứ tự ${a.position} ≠ ${b.position}`);

    const oldBody = norm(a.body);
    const newBody = norm(b.body);
    if (oldBody !== newBody) {
      textDrift++;
      if (textDrift <= 3) {
        // Chỉ ra đúng chỗ rẽ nhánh đầu tiên; in 160 ký tự đầu của cả hai bên
        // thì gần như lúc nào cũng giống hệt nhau và chẳng nói lên điều gì.
        let at = 0;
        while (at < oldBody.length && at < newBody.length && oldBody[at] === newBody[at]) at++;
        const from = Math.max(0, at - 60);
        out.push(
          `bài #${a.id}: text lệch tại ký tự ${at} (cũ ${a.body.length}, mới ${b.body.length})\n` +
          `  cũ : …${oldBody.slice(from, at)}⟦${oldBody.slice(at, at + 40)}⟧…\n` +
          `  mới: …${newBody.slice(from, at)}⟦${newBody.slice(at, at + 40)}⟧…`,
        );
      }
    }
  }

  if (textDrift > 3) out.push(`... và ${textDrift - 3} bài nữa lệch text`);
  return out;
}

/* ------------------------------------------------------------------ crawl */

async function crawlAndLog(env: Env, opts: CrawlOptions = {}): Promise<CrawlStats> {
  const runId = await store.startRun(env.DB);
  try {
    const stats = await runCrawl(env, opts);
    await store.finishRun(env.DB, runId, {
      fetches: stats.fetches,
      newThreads: stats.newThreads,
      newPosts: stats.newPosts,
      goneFound: stats.goneFound,
    }, stats.notes.length ? stats.notes.join(" | ").slice(0, 900) : undefined);
    return stats;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await store.finishRun(env.DB, runId, { fetches: 0, newThreads: 0, newPosts: 0, goneFound: 0 }, msg);
    throw e;
  }
}
