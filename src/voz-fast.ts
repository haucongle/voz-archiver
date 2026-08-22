import { BASE_URL } from "./config";
import { decodeEntities, type ParsedPost, type ParsedThreadPage } from "./voz";

/**
 * Parser thay thế cho bản HTMLRewriter, viết bằng thao tác chuỗi thuần.
 *
 * Lý do tồn tại: bản HTMLRewriter dùng selector `article[data-content^="post-"] *`,
 * nghĩa là chạy một callback JS cho mọi element trong mọi bài. Một trang 218 KB
 * có hàng nghìn element, nên chi phí nằm ở số lần vượt biên Rust↔JS chứ không
 * phải ở việc tokenize HTML. Bản này không vượt biên lần nào; đổi lại nó phải
 * tự đếm độ sâu thẻ thay vì được parser lo giùm.
 *
 * Khác biệt có chủ ý so với bản cũ, xem `/bench` để đối chiếu:
 *
 *  - Giữ nguyên entity trong HTML thay vì giải mã rồi escape lại. Trình duyệt
 *    tự hiểu `&#039;`, nên cách này vừa rẻ hơn vừa tránh luôn được cái bẫy
 *    `&amp;amp;` làm hỏng URL ảnh proxy.
 *  - URL bắt đầu bằng `//` được để yên. Bản cũ nối BASE_URL vào trước, biến
 *    `//cdn.example/x` thành `https://voz.vn//cdn.example/x`.
 */

/** Thẻ có cặp đóng mở, cắt cả khối. */
const PAIRED_DROP =
  /<(script|style|noscript|iframe|object|form|button|select|textarea|pubtag)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/** Thẻ rỗng, cắt riêng vì không có thẻ đóng để bám vào. */
const VOID_DROP = /<(?:input|embed)\b[^>]*>/gi;
const EVENT_ATTR = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const NOISE_ATTR = /\s(?:srcset|loading|data-xf[\w-]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const IMG_TAG = /<img\b[^>]*>/gi;
const LAZY_SRC = /\sdata-src="([^"]*)"/i;
const HAS_SRC = /\ssrc="[^"]*"/i;
/** Đường dẫn gốc, nhưng bỏ qua `//` vì đó là URL theo giao thức hiện hành. */
const ROOT_URL_ATTR = /\s(href|src)="\/(?!\/)/gi;

const ARTICLE_OPEN = /<article\b[^>]*\bdata-content="post-(\d+)"[^>]*>/gi;
const ATTR_AUTHOR = /\bdata-author="([^"]*)"/i;
const ATTR_TIMESTAMP = /\bdata-timestamp="(\d+)"/i;
const TITLE_BLOCK = /<h1\b[^>]*\bclass="[^"]*\bp-title-value\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i;
/** Số trang nằm trong `li.pageNav-page`; giới hạn cửa sổ quét để khỏi vơ nhầm
 *  link `/page-N` do người dùng dán trong bài. */
const PAGE_NAV = /class="[^"]*\bpageNav-page\b[^"]*"[\s\S]{0,400}?\/page-(\d+)/gi;

export function parseThreadPageFast(html: string): ParsedThreadPage {
  return {
    title: extractTitle(html),
    pageCount: extractPageCount(html),
    posts: extractPosts(html),
  };
}

export async function parseThreadPageFastFromResponse(
  res: Response,
): Promise<ParsedThreadPage> {
  return parseThreadPageFast(await res.text());
}

/* ----------------------------------------------------------------- phần đầu */

function extractTitle(html: string): string {
  const m = html.match(TITLE_BLOCK);
  if (!m) return "";
  // Tiêu đề trong <h1> vẫn còn nguyên entity, y như mọi chỗ khác. Quên bước
  // này thì thread có dấu nháy sẽ hiện `&quot;` giữa tiêu đề.
  const text = stripTags(m[1]).trim();
  return text.includes("&") ? decodeEntities(text) : text;
}

function extractPageCount(html: string): number {
  let max = 1;
  PAGE_NAV.lastIndex = 0;
  for (const m of html.matchAll(PAGE_NAV)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

/* -------------------------------------------------------------------- bài */

function extractPosts(html: string): ParsedPost[] {
  const posts: ParsedPost[] = [];
  ARTICLE_OPEN.lastIndex = 0;

  for (const m of html.matchAll(ARTICLE_OPEN)) {
    const id = Number(m[1]);
    if (!Number.isSafeInteger(id) || id <= 0) continue;

    const bodyStart = m.index! + m[0].length;
    const end = html.indexOf("</article", bodyStart);
    const article = html.slice(bodyStart, end < 0 ? undefined : end);

    const authorRaw = m[0].match(ATTR_AUTHOR)?.[1] ?? "";
    const tsRaw = article.match(ATTR_TIMESTAMP)?.[1];
    const ts = tsRaw ? Number(tsRaw) : 0;

    const raw = sliceBbWrapper(article);
    const clean = raw === null ? "" : cleanHtml(raw);

    posts.push({
      id,
      author: authorRaw.includes("&") ? decodeEntities(authorRaw) : authorRaw,
      postedAt: Number.isFinite(ts) && ts > 0 ? ts : 0,
      position: extractPosition(article),
      html: clean.trim(),
      body: htmlToText(clean),
    });
  }

  return posts;
}

/**
 * Số thứ tự `#N` nằm trong <header> của bài. Quote lồng nhau cũng có thể chứa
 * dấu thăng nên phải giới hạn vùng tìm, không quét cả bài.
 */
function extractPosition(article: string): number | null {
  const open = article.indexOf("<header");
  if (open < 0) return null;
  const close = article.indexOf("</header", open);
  if (close < 0) return null;
  const m = stripTags(article.slice(open, close)).match(/#(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Lấy phần trong của `.bbWrapper` ngoài cùng.
 *
 * Không thể cắt tới `</div>` đầu tiên vì quote lồng nhau cũng là div, và bản
 * thân quote cũng chứa một `.bbWrapper` nữa. Phải đếm độ sâu, đúng cái bẫy mà
 * bản HTMLRewriter đã vấp.
 */
function sliceBbWrapper(article: string): string | null {
  const marker = article.indexOf("bbWrapper");
  if (marker < 0) return null;

  const tagOpen = article.lastIndexOf("<", marker);
  const tagClose = article.indexOf(">", marker);
  if (tagOpen < 0 || tagClose < 0) return null;

  const start = tagClose + 1;
  let depth = 1;
  let i = start;

  while (depth > 0) {
    const nextOpen = article.indexOf("<div", i);
    const nextClose = article.indexOf("</div", i);

    // HTML cụt: giữ những gì còn lại còn hơn vứt cả bài.
    if (nextClose < 0) return article.slice(start);

    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 4;
    } else {
      depth--;
      if (depth === 0) return article.slice(start, nextClose);
      i = nextClose + 5;
    }
  }

  return null;
}

/* ------------------------------------------------------------------- dọn */

function cleanHtml(raw: string): string {
  let out = raw;

  // Đa số bài không có thẻ rác nào, nên hỏi trước rẻ hơn là quét mù.
  if (out.includes("<script") || out.includes("<iframe") || out.includes("<form") ||
      out.includes("<style") || out.includes("<pubtag") || out.includes("<object") ||
      out.includes("<noscript") || out.includes("<button") || out.includes("<select") ||
      out.includes("<textarea")) {
    out = out.replace(PAIRED_DROP, "");
  }
  if (out.includes("<input") || out.includes("<embed")) {
    out = out.replace(VOID_DROP, "");
  }
  if (out.includes(" on")) out = out.replace(EVENT_ATTR, "");
  if (out.includes("srcset") || out.includes("loading") || out.includes("data-xf")) {
    out = out.replace(NOISE_ATTR, "");
  }
  // Ảnh lazy-load: src chỉ là placeholder SVG, URL thật nằm ở data-src.
  if (out.includes("data-src")) out = out.replace(IMG_TAG, promoteLazySrc);
  out = out.replace(ROOT_URL_ATTR, ` $1="${BASE_URL}/`);

  return out;
}

function promoteLazySrc(tag: string): string {
  const lazy = tag.match(LAZY_SRC);
  if (!lazy) return tag;
  const real = ` src="${lazy[1]}"`;
  const withoutLazy = tag.replace(LAZY_SRC, "");
  return HAS_SRC.test(withoutLazy)
    ? withoutLazy.replace(HAS_SRC, real)
    : withoutLazy.replace(/^<img\b/i, `<img${real}`);
}

/* ------------------------------------------------------------------ text */

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function htmlToText(html: string): string {
  if (!html) return "";
  const spaced = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|blockquote|li|tr|h[1-6])\s*>/gi, "\n");
  const stripped = stripTags(spaced);
  const decoded = stripped.includes("&") ? decodeEntities(stripped) : stripped;
  return decoded.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
