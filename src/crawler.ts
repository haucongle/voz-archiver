import { FETCH_DELAY_MS, FORUMS, USER_AGENT } from "./config";
import { numVar, type Env } from "./env";
import * as store from "./store";
import { forumRssUrl, parseRss, parseThreadPage, threadUrl, type ParsedThreadPage } from "./voz";
import { parseThreadPageFast } from "./voz-fast";

export interface CrawlStats {
  fetches: number;
  pages: number;
  newThreads: number;
  newPosts: number;
  goneFound: number;
  notes: string[];
}

export interface CrawlOptions {
  /**
   * Bỏ giai đoạn RSS. Lịch cron chạy mỗi phút để có đủ lượt parse trong hạn
   * mức CPU 10 ms, nhưng phát hiện thread mới thì 5 phút một lần là thừa sức,
   * và hỏi RSS mỗi phút là làm phiền voz vô ích.
   */
  skipRss?: boolean;
}

/**
 * `fast` là parser chuỗi, mặc định. Hai chế độ HTMLRewriter giữ lại để `/bench`
 * còn thứ mà đối chiếu; chúng đắt hơn 30–140 lần nên đừng bật trên gói Free.
 */
export type CrawlParseMode = "fast" | "full" | "text";

function pickParseMode(raw: string | undefined): CrawlParseMode {
  return raw === "full" || raw === "text" ? raw : "fast";
}

async function parsePage(res: Response, mode: CrawlParseMode): Promise<ParsedThreadPage> {
  return mode === "fast" ? parseThreadPageFast(await res.text()) : parseThreadPage(res, mode);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function politeFetch(url: string, skipDelay = false): Promise<Response> {
  if (!skipDelay) await sleep(FETCH_DELAY_MS);
  return fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "vi,en-US;q=0.8,en;q=0.6",
      "Cache-Control": "no-cache",
    },
  });
}

export async function runCrawl(env: Env, opts: CrawlOptions = {}): Promise<CrawlStats> {
  const stats: CrawlStats = {
    fetches: 0,
    pages: 0,
    newThreads: 0,
    newPosts: 0,
    goneFound: 0,
    notes: [],
  };

  const maxFetches = numVar(env.MAX_SUBREQUESTS, 45);
  const maxPages = numVar(env.MAX_PAGES_PER_RUN, 2);
  const maxNewThreads = numVar(env.MAX_NEW_THREADS, 8);
  const activeWindow = numVar(env.ACTIVE_WINDOW_HOURS, 72);
  const parseMode = pickParseMode(env.PARSE_MODE);
  // Sàn 2 để thread mới luôn lấy được cả trang đầu lẫn trang cuối trong
  // cùng một lượt, nếu không thì lượt sau sẽ mất dấu và bò lại từ đầu.
  const maxPagesPerThread = Math.max(2, numVar(env.MAX_PAGES_PER_THREAD, 3));

  // --- Giai đoạn 1: phát hiện thread mới qua RSS (rẻ, 1 request mỗi box).
  for (const forum of opts.skipRss ? [] : FORUMS) {
    if (stats.fetches >= maxFetches) break;
    try {
      const res = await politeFetch(forumRssUrl(forum.id, forum.slug), stats.fetches === 0);
      stats.fetches++;
      if (!res.ok) {
        stats.notes.push(`RSS box ${forum.id} trả về ${res.status}`);
        continue;
      }
      const items = parseRss(await res.text(), forum.name);
      if (items.length === 0) {
        stats.notes.push(`RSS box ${forum.id} không parse được item nào`);
        continue;
      }
      await store.upsertThreadsFromRss(env.DB, items, forum.id);
    } catch (e) {
      stats.notes.push(`RSS box ${forum.id} lỗi: ${errText(e)}`);
    }
  }

  // --- Giai đoạn 2: tải nội dung đầy đủ, giới hạn theo ngân sách.
  const candidates = await store.pickThreadsToCrawl(env.DB, 60, activeWindow);

  for (const thread of candidates) {
    if (stats.fetches >= maxFetches || stats.pages >= maxPages) break;

    const isNew = thread.last_crawled === null;
    if (isNew && stats.newThreads >= maxNewThreads) continue;

    // Chiến lược chọn trang. Thread mới gặp lần đầu có thể là thread cũ vừa
    // bị đào lên và có hàng nghìn trang; bò từ trang 1 sẽ đốt sạch ngân sách
    // vào nội dung từ đời nào. Nên lấy trang 1 để có bài mở đầu, rồi nhảy
    // thẳng tới trang cuối nơi cuộc thảo luận đang diễn ra. Phần giữa không
    // backfill, vì mục tiêu là giữ những gì sắp bị xóa chứ không phải chép
    // lại toàn bộ lịch sử diễn đàn.
    const queue: number[] = [isNew ? 1 : Math.max(1, thread.pages_seen)];
    const done = new Set<number>();

    let pageCount = Math.max(1, thread.page_count);
    let pagesSeen = thread.pages_seen;
    let title = "";
    let vanished = false;
    let touched = false;
    let pagesThisThread = 0;

    while (
      queue.length > 0 &&
      pagesThisThread < maxPagesPerThread &&
      stats.fetches < maxFetches &&
      stats.pages < maxPages
    ) {
      const page = queue.shift()!;
      if (done.has(page) || page < 1) continue;
      done.add(page);

      let res: Response;
      try {
        res = await politeFetch(threadUrl(thread.id, thread.slug, page), stats.fetches === 0);
        stats.fetches++;
      } catch (e) {
        stats.notes.push(`thread ${thread.id} trang ${page} lỗi: ${errText(e)}`);
        break;
      }

      if (res.status === 404 || res.status === 403 || res.status === 410) {
        await store.markThreadGone(env.DB, thread.id, res.status);
        stats.goneFound++;
        vanished = true;
        break;
      }
      if (!res.ok) {
        stats.notes.push(`thread ${thread.id} trang ${page} trả về ${res.status}`);
        break;
      }

      const parsed = await parsePage(res, parseMode);
      stats.pages++;
      pagesThisThread++;
      touched = true;

      if (parsed.posts.length === 0) {
        stats.notes.push(`thread ${thread.id} trang ${page}: không bóc được bài nào`);
        break;
      }

      pageCount = Math.max(pageCount, parsed.pageCount);
      if (parsed.title) title = parsed.title;

      const saved = await store.savePage(env.DB, thread.id, page, parsed.posts);
      stats.newPosts += saved.inserted;
      stats.goneFound += saved.goneFound;

      pagesSeen = Math.max(pagesSeen, page);

      if (isNew) {
        // Vừa biết tổng số trang: nhảy tới cuối, bỏ qua phần giữa.
        if (page === 1 && pageCount > 1) queue.push(pageCount);
      } else if (page < pageCount) {
        // Thread đang theo dõi: đi tiếp tới các trang mới sinh ra.
        queue.push(page + 1);
      }
    }

    if (vanished) continue;

    if (touched) {
      if (isNew) {
        stats.newThreads++;
        // Đã cố ý bỏ qua phần giữa, nên đánh dấu là xong để lượt sau không
        // coi thread này là còn thiếu trang và đi backfill.
        if (done.has(pageCount)) pagesSeen = pageCount;
      }
      await store.finishThreadCrawl(env.DB, thread.id, title, pageCount, pagesSeen);
    }
  }

  return stats;
}
