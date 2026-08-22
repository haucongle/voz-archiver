import type { ParsedPost, RssItem } from "./voz";

export interface ThreadRow {
  id: number;
  slug: string;
  title: string;
  forum_id: number | null;
  forum_name: string | null;
  author: string | null;
  first_seen: number;
  last_activity: number | null;
  last_crawled: number | null;
  pages_seen: number;
  page_count: number;
  post_count: number;
  gone_at: number | null;
  gone_status: number | null;
}

export const now = () => Math.floor(Date.now() / 1000);

/* -------------------------------------------------------------- threads */

export async function upsertThreadsFromRss(
  db: D1Database,
  items: RssItem[],
  forumId: number,
): Promise<void> {
  if (items.length === 0) return;
  const ts = now();

  // Mệnh đề WHERE ở cuối là để tiết kiệm lượt ghi. Feed trả về 20 item mỗi
  // lần hỏi và phần lớn lặp lại y nguyên so với lần trước; không có nó thì
  // riêng khâu đọc RSS đã ngốn hơn 11 nghìn dòng ghi mỗi ngày mà chẳng thay
  // đổi gì. Bỏ qua cũng đồng nghĩa slug và tiêu đề chỉ được làm mới khi
  // thread có hoạt động mới, và như vậy là đủ.
  const stmt = db.prepare(
    `INSERT INTO threads (id, slug, title, forum_id, forum_name, author, first_seen, last_activity)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET
       slug          = excluded.slug,
       title         = excluded.title,
       forum_name    = excluded.forum_name,
       last_activity = MAX(COALESCE(threads.last_activity, 0), excluded.last_activity)
     WHERE excluded.last_activity > COALESCE(threads.last_activity, 0)`,
  );

  await db.batch(
    items.map((i) =>
      stmt.bind(i.threadId, i.slug, i.title, forumId, i.forumName, i.author, ts, i.lastActivity),
    ),
  );
}

/**
 * Thread cần tải, theo thứ tự ưu tiên:
 *   1. Chưa từng crawl (nguy cơ bị xóa trước khi kịp lưu là cao nhất).
 *   2. Còn trang chưa tải xong vì lượt trước hết ngân sách.
 *   3. Có bài mới kể từ lần crawl gần nhất và vẫn trong cửa sổ hoạt động.
 * Thread đã biến mất thì bỏ hẳn để khỏi phí subrequest.
 */
export async function pickThreadsToCrawl(
  db: D1Database,
  limit: number,
  activeWindowHours: number,
): Promise<ThreadRow[]> {
  const cutoff = now() - activeWindowHours * 3600;
  const res = await db
    .prepare(
      `SELECT * FROM threads
        WHERE gone_at IS NULL
          AND (last_crawled IS NULL
               OR pages_seen < page_count
               OR (COALESCE(last_activity, 0) > last_crawled
                   AND COALESCE(last_activity, 0) >= ?1))
        ORDER BY (last_crawled IS NULL) DESC,
                 (pages_seen < page_count) DESC,
                 COALESCE(last_activity, 0) DESC
        LIMIT ?2`,
    )
    .bind(cutoff, limit)
    .all<ThreadRow>();
  return res.results ?? [];
}

export async function markThreadGone(
  db: D1Database,
  threadId: number,
  status: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE threads SET gone_at = ?1, gone_status = ?2, last_crawled = ?1
        WHERE id = ?3 AND gone_at IS NULL`,
    )
    .bind(now(), status, threadId)
    .run();
}

export async function finishThreadCrawl(
  db: D1Database,
  threadId: number,
  title: string,
  pageCount: number,
  pagesSeen: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE threads SET
         last_crawled = ?1,
         page_count   = MAX(page_count, ?2),
         pages_seen   = MAX(pages_seen, ?3),
         title        = CASE WHEN ?4 <> '' THEN ?4 ELSE title END,
         post_count   = (SELECT COUNT(*) FROM posts WHERE thread_id = ?5)
       WHERE id = ?5`,
    )
    .bind(now(), pageCount, pagesSeen, title, threadId)
    .run();
}

/* ---------------------------------------------------------------- posts */

export interface SaveResult {
  inserted: number;
  /** Bài đã có nhưng nội dung đổi nên phải ghi đè. */
  rewritten: number;
  /** Bài đã có và y nguyên, không tốn lượt ghi nào. */
  skipped: number;
  goneFound: number;
}

const encoder = new TextEncoder();
const byteLen = (s: string) => encoder.encode(s).length;

/**
 * Ghi lại một trang, nhưng chỉ đụng vào những bài thật sự đổi.
 *
 * Bản đầu upsert cả 20 bài mỗi lần chạm vào một trang. Đó là cách nhanh nhất
 * đốt sạch hạn mức 100 nghìn dòng ghi mỗi ngày của D1 bản free, vì tải lại
 * trang cuối của một thread đang sống thường chỉ thêm được một hai bài mới,
 * mà mỗi lượt ghi đè còn kéo theo trigger xóa-rồi-chèn của chỉ mục FTS. Nó
 * cũng là khoản CPU đắt nhất của mỗi lượt chạy, vì phải gắn tham số cho vài
 * chục chuỗi HTML dài mấy KB.
 */
export async function savePage(
  db: D1Database,
  threadId: number,
  page: number,
  posts: ParsedPost[],
): Promise<SaveResult> {
  if (posts.length === 0) return { inserted: 0, rewritten: 0, skipped: 0, goneFound: 0 };

  const ids = posts.map((p) => p.id);
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");

  // CAST sang BLOB để LENGTH trả về số byte, khớp với TextEncoder bên JS.
  // LENGTH trên TEXT đếm ký tự Unicode, còn `.length` của JS đếm đơn vị
  // UTF-16, nên bài nào có emoji là hai bên lệch nhau và bài đó sẽ bị coi
  // là đổi mãi mãi.
  const existing = await db
    .prepare(
      `SELECT id, page, gone_at,
              LENGTH(CAST(html AS BLOB)) AS hlen,
              LENGTH(CAST(body AS BLOB)) AS blen
         FROM posts WHERE id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{ id: number; page: number; gone_at: number | null; hlen: number | null; blen: number | null }>();

  const known = new Map((existing.results ?? []).map((r) => [r.id, r]));

  const changed: ParsedPost[] = [];
  const metaOnly: number[] = [];
  let fresh = 0;

  for (const p of posts) {
    const prev = known.get(p.id);
    if (!prev) {
      changed.push(p);
      fresh++;
      continue;
    }
    // So kích thước thay cho băm nội dung: rẻ hơn nhiều, và một lần sửa bài
    // giữ nguyên đúng từng byte thì cũng chẳng có gì đáng lưu lại.
    if (prev.hlen !== byteLen(p.html) || prev.blen !== byteLen(p.body)) {
      changed.push(p);
      continue;
    }
    // Nội dung y nguyên nhưng bài đã trôi sang trang khác vì có bài phía
    // trước bị xóa, hoặc từng bị đánh dấu xóa mà nay xuất hiện lại. Sửa mỗi
    // siêu dữ liệu thì không động tới `body` nên trigger FTS không chạy.
    if (prev.page !== page || prev.gone_at !== null) metaOnly.push(p.id);
  }

  const ts = now();

  if (changed.length > 0) {
    const upsert = db.prepare(
      `INSERT INTO posts (id, thread_id, page, position, author, posted_at, html, body, archived_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(id) DO UPDATE SET
         page     = excluded.page,
         position = excluded.position,
         html     = excluded.html,
         body     = excluded.body,
         gone_at  = NULL`,
    );
    await db.batch(
      changed.map((p) =>
        upsert.bind(p.id, threadId, page, p.position, p.author, p.postedAt, p.html, p.body, ts),
      ),
    );
  }

  if (metaOnly.length > 0) {
    await db
      .prepare(
        `UPDATE posts SET page = ?1, gone_at = NULL
          WHERE id IN (${metaOnly.map((_, i) => `?${i + 2}`).join(",")})`,
      )
      .bind(page, ...metaOnly)
      .run();
  }

  // Bài từng lưu ở trang này mà giờ không còn nữa: mod đã xóa lẻ.
  // Chỉ chạy khi trang trả về ít nhất một bài, tránh việc parser hỏng
  // khiến toàn bộ trang bị đánh dấu nhầm là đã xóa.
  const goneRes = await db
    .prepare(
      `UPDATE posts SET gone_at = ?1
        WHERE thread_id = ?2 AND page = ?3 AND gone_at IS NULL
          AND id NOT IN (${ids.map((_, i) => `?${i + 4}`).join(",")})`,
    )
    .bind(ts, threadId, page, ...ids)
    .run();

  return {
    inserted: fresh,
    rewritten: changed.length - fresh,
    skipped: posts.length - changed.length,
    goneFound: goneRes.meta?.changes ?? 0,
  };
}

/* ----------------------------------------------------------------- runs */

export async function startRun(db: D1Database): Promise<number> {
  const res = await db
    .prepare(`INSERT INTO runs (started_at) VALUES (?1)`)
    .bind(now())
    .run();
  return Number(res.meta?.last_row_id ?? 0);
}

export async function finishRun(
  db: D1Database,
  runId: number,
  stats: { fetches: number; newThreads: number; newPosts: number; goneFound: number },
  error?: string,
): Promise<void> {
  if (!runId) return;
  await db
    .prepare(
      `UPDATE runs SET finished_at = ?1, fetches = ?2, new_threads = ?3,
                       new_posts = ?4, gone_found = ?5, error = ?6
        WHERE id = ?7`,
    )
    .bind(now(), stats.fetches, stats.newThreads, stats.newPosts, stats.goneFound, error ?? null, runId)
    .run();
}
