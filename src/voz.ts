import { BASE_URL } from "./config";

export interface RssItem {
  threadId: number;
  slug: string;
  title: string;
  author: string;
  forumName: string;
  lastActivity: number;
}

export interface ParsedPost {
  id: number;
  author: string;
  postedAt: number;
  position: number | null;
  html: string;
  body: string;
}

export interface ParsedThreadPage {
  title: string;
  pageCount: number;
  posts: ParsedPost[];
}

/* ------------------------------------------------------------------ URLs */

export function forumRssUrl(forumId: number, slug: string): string {
  return `${BASE_URL}/f/${slug}.${forumId}/index.rss`;
}

export function threadUrl(threadId: number, slug: string, page = 1): string {
  const root = `${BASE_URL}/t/${slug}.${threadId}/`;
  return page > 1 ? `${root}page-${page}` : root;
}

export function parseThreadUrl(url: string): { slug: string; id: number } | null {
  const m = url.match(/\/t\/([^/]+?)\.(\d+)\/?(?:[?#]|$)/);
  if (!m) return null;
  const id = Number(m[2]);
  return Number.isSafeInteger(id) && id > 0 ? { slug: m[1], id } : null;
}

/* ------------------------------------------------------------------- RSS */

/**
 * XenForo sinh RSS rất ổn định nên regex an toàn hơn là ép một parser HTML
 * đọc XML. Cụ thể HTMLRewriter coi <link> là thẻ void nên sẽ làm hỏng feed.
 */
export function parseRss(xml: string, fallbackForum: string): RssItem[] {
  const items: RssItem[] = [];

  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const chunk = match[1];
    const link = pickTag(chunk, "link");
    const parsed = link ? parseThreadUrl(link) : null;
    if (!parsed) continue;

    const pubDate = pickTag(chunk, "pubDate");
    const ts = pubDate ? Math.floor(Date.parse(pubDate) / 1000) : NaN;

    items.push({
      threadId: parsed.id,
      slug: parsed.slug,
      title: pickTag(chunk, "title"),
      author: pickTag(chunk, "dc:creator"),
      forumName: pickTag(chunk, "category") || fallbackForum,
      lastActivity: Number.isFinite(ts) ? ts : Math.floor(Date.now() / 1000),
    });
  }

  return items;
}

function pickTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  if (!m) return "";
  const raw = m[1].trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return cdata ? cdata[1].trim() : decodeEntities(raw);
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(n: number): string {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

/**
 * HTMLRewriter trả về text chunk còn nguyên entity HTML, nên nếu lưu thẳng
 * thì `&#039;` sẽ hiện ra nguyên văn thay vì dấu nháy đơn. Kiểm tra ký tự '&'
 * trước để khỏi chạy bảy lượt regex trên phần lớn chunk vốn đã sạch.
 */
function decodeChunk(s: string): string {
  return s.includes("&") ? decodeEntities(s) : s;
}

/* ------------------------------------------------------- Thread page HTML */

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img",
  "input", "link", "meta", "source", "track", "wbr",
]);

/** Bỏ hẳn khỏi bản lưu: script chèn quảng cáo, form, iframe nhúng. */
const DROP_TAGS = new Set([
  "script", "style", "noscript", "iframe", "object",
  "embed", "form", "input", "button", "select", "textarea", "pubtag",
]);

/**
 * Bóc toàn bộ bài viết trên một trang thread.
 *
 * Cạm bẫy đã xử lý:
 *  - voz chèn quảng cáo bằng <div class="message message--post">, nên không
 *    thể chọn theo class mà phải chọn article[data-content^="post-"].
 *  - Ảnh dùng lazy-load: src là placeholder SVG, URL thật nằm ở data-src.
 *  - Quote lồng nhau cũng chứa .bbWrapper, phải đếm độ sâu chứ không thể
 *    bật/tắt cờ theo từng lần khớp selector.
 */
export type ParseMode = "full" | "text";

export async function parseThreadPage(
  res: Response,
  mode: ParseMode = "full",
): Promise<ParsedThreadPage> {
  const posts: ParsedPost[] = [];
  const keepHtml = mode === "full";

  let title = "";
  let pageCount = 1;

  let current: {
    id: number;
    author: string;
    postedAt: number;
    header: string;
  } | null = null;

  let htmlBuf: string[] = [];
  let textBuf: string[] = [];
  let capturing = false;
  let dropDepth = 0;

  const flush = () => {
    if (!current) return;
    const body = textBuf.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const posMatch = current.header.match(/#(\d+)/);
    posts.push({
      id: current.id,
      author: current.author,
      postedAt: current.postedAt,
      position: posMatch ? Number(posMatch[1]) : null,
      html: htmlBuf.join("").trim(),
      body,
    });
    current = null;
    htmlBuf = [];
    textBuf = [];
    capturing = false;
    dropDepth = 0;
  };

  let rewriter = new HTMLRewriter()
    .on("h1.p-title-value", {
      text(t) {
        title += t.text;
      },
    })
    .on("li.pageNav-page a", {
      element(el) {
        const m = (el.getAttribute("href") || "").match(/\/page-(\d+)/);
        if (m) pageCount = Math.max(pageCount, Number(m[1]));
      },
    })
    .on('article[data-content^="post-"]', {
      element(el) {
        flush();
        const id = Number((el.getAttribute("data-content") || "").slice(5));
        if (!Number.isSafeInteger(id) || id <= 0) return;
        current = {
          id,
          author: el.getAttribute("data-author") || "",
          postedAt: 0,
          header: "",
        };
        el.onEndTag(() => flush());
      },
    })
    .on('article[data-content^="post-"] time', {
      element(el) {
        if (!current || current.postedAt) return;
        const ts = Number(el.getAttribute("data-timestamp"));
        if (Number.isFinite(ts) && ts > 0) current.postedAt = ts;
      },
    })
    .on('article[data-content^="post-"] header', {
      text(t) {
        if (current) current.header += t.text;
      },
    });

  // Chế độ "text" tồn tại vì chế độ "full" phải chạy một callback JS cho từng
  // element để dựng lại HTML, và đó là toàn bộ chi phí CPU. Ở đây ta chỉ gắn
  // callback vào vài element hiếm gặp, còn lại thuần text.
  if (!keepHtml) {
    const dropOnly = {
      element(el: Element) {
        if (!current || VOID_TAGS.has(el.tagName.toLowerCase())) return;
        dropDepth++;
        el.onEndTag(() => {
          dropDepth--;
        });
      },
    };
    rewriter = rewriter
      .on('article[data-content^="post-"] .bbWrapper', {
        element(el) {
          if (!current || capturing) return;
          capturing = true;
          el.onEndTag(() => {
            capturing = false;
          });
        },
      })
      .on('article[data-content^="post-"] script', dropOnly)
      .on('article[data-content^="post-"] style', dropOnly)
      .on('article[data-content^="post-"] br', {
        element() {
          if (current && capturing && dropDepth === 0) textBuf.push("\n");
        },
      })
      .on('article[data-content^="post-"] *', {
        text(t) {
          if (!current || !capturing || dropDepth > 0) return;
          textBuf.push(decodeChunk(t.text));
        },
      });

    await rewriter.transform(res).arrayBuffer();
    flush();
    return { title: decodeChunk(title).trim(), pageCount, posts };
  }

  rewriter = rewriter
    .on('article[data-content^="post-"] *', {
      element(el) {
        if (!current) return;
        const tag = el.tagName.toLowerCase();
        const closes = !VOID_TAGS.has(tag);

        if (dropDepth > 0) {
          if (closes) {
            dropDepth++;
            el.onEndTag(() => {
              dropDepth--;
            });
          }
          return;
        }

        if (!capturing) {
          // Chỉ .bbWrapper ngoài cùng mới mở vùng thu thập.
          const classes = (el.getAttribute("class") || "").split(/\s+/);
          if (classes.includes("bbWrapper") && closes) {
            capturing = true;
            el.onEndTag(() => {
              capturing = false;
            });
          }
          return;
        }

        if (DROP_TAGS.has(tag)) {
          if (closes) {
            dropDepth++;
            el.onEndTag(() => {
              dropDepth--;
            });
          }
          return;
        }

        htmlBuf.push(serializeStartTag(el, tag));
        if (tag === "br") textBuf.push("\n");
        if (closes) {
          el.onEndTag(() => {
            htmlBuf.push(`</${tag}>`);
            if (tag === "blockquote" || tag === "div" || tag === "p") textBuf.push("\n");
          });
        }
      },
      text(t) {
        if (!current || !capturing || dropDepth > 0) return;
        const decoded = decodeChunk(t.text);
        htmlBuf.push(escapeText(decoded));
        textBuf.push(decoded);
      },
    });

  // Handler chỉ chạy khi luồng thực sự được tiêu thụ.
  await rewriter.transform(res).arrayBuffer();
  flush();

  return { title: decodeChunk(title).trim(), pageCount, posts };
}

function serializeStartTag(el: Element, tag: string): string {
  const parts: string[] = [];

  for (const [rawKey, rawValue] of el.attributes) {
    const key = rawKey.toLowerCase();
    if (key.startsWith("on")) continue;
    if (key === "srcset" || key === "loading" || key.startsWith("data-xf")) continue;

    // Giá trị thuộc tính cũng chưa được giải mã, y như text chunk. Bỏ qua
    // bước này thì URL dạng proxy.php?image=...&amp;hash=... sẽ bị escape
    // thành &amp;amp; và voz trả về ảnh báo lỗi thay vì ảnh thật.
    let value = decodeChunk(rawValue);

    // Ảnh lazy-load: src thật nằm ở data-src, src chỉ là placeholder SVG.
    if (tag === "img" && key === "src") {
      const lazy = el.getAttribute("data-src");
      if (lazy) value = decodeChunk(lazy);
    }
    if ((key === "href" || key === "src") && value.startsWith("/")) {
      value = BASE_URL + value;
    }
    parts.push(` ${key}="${escapeAttr(value)}"`);
  }

  return `<${tag}${parts.join("")}>`;
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}
