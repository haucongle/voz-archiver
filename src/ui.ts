export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Workers không đảm bảo có ICU đầy đủ nên tự cộng offset +07:00. */
export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date((ts + 7 * 3600) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())}`;
}

export function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return "";
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return "vừa xong";
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return `${Math.floor(s / 86400)} ngày trước`;
}

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0 16px 64px;
  background: #14161a; color: #dfe3e8;
  font: 15px/1.65 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
.wrap { max-width: 860px; margin: 0 auto; }
header.top {
  display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
  padding: 20px 0 14px; border-bottom: 1px solid #262a31; margin-bottom: 20px;
}
header.top h1 { font-size: 18px; margin: 0; font-weight: 600; letter-spacing: .2px; }
header.top nav { display: flex; gap: 14px; font-size: 14px; }
a { color: #6ea8fe; text-decoration: none; }
a:hover { text-decoration: underline; }
.muted { color: #868e99; font-size: 13px; }
form.search { display: flex; gap: 8px; margin: 0 0 20px; }
form.search input[type=search] {
  flex: 1; padding: 9px 12px; border-radius: 8px;
  border: 1px solid #303640; background: #1c1f25; color: #dfe3e8; font-size: 14px;
}
form.search button {
  padding: 9px 18px; border-radius: 8px; border: 0;
  background: #2f6feb; color: #fff; font-size: 14px; cursor: pointer;
}
ul.threads { list-style: none; margin: 0; padding: 0; }
ul.threads li { padding: 13px 0; border-bottom: 1px solid #22262d; }
ul.threads .title { font-size: 15px; font-weight: 500; }
.badge {
  display: inline-block; padding: 1px 7px; border-radius: 999px;
  font-size: 11px; font-weight: 600; vertical-align: middle; margin-left: 7px;
}
.badge.gone { background: #4a1d22; color: #ff8a95; }
.badge.live { background: #1d3a29; color: #6ee7a0; }
article.post {
  border: 1px solid #262a31; border-radius: 10px;
  padding: 14px 16px; margin-bottom: 14px; background: #1a1d22;
}
article.post.gone { border-color: #5c2028; background: #1f1416; }
article.post .meta {
  display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap;
  margin-bottom: 9px; font-size: 13px; color: #868e99;
}
article.post .meta .who { color: #dfe3e8; font-weight: 600; }
.content { overflow-wrap: anywhere; }
.content img { max-width: 100%; height: auto; border-radius: 6px; }
.content img.smilie { width: 20px; height: 20px; vertical-align: text-bottom; }
.content blockquote {
  margin: 10px 0; padding: 9px 13px;
  border-left: 3px solid #3a4150; background: #202429; border-radius: 0 6px 6px 0;
  color: #aeb6c0; font-size: 14px;
}
.content a { word-break: break-all; }
mark { background: #6b5a12; color: #ffe89a; padding: 0 2px; border-radius: 2px; }
.empty { padding: 48px 0; text-align: center; color: #868e99; }
table.stats { border-collapse: collapse; font-size: 14px; width: 100%; }
table.stats td { padding: 5px 12px 5px 0; border-bottom: 1px solid #22262d; }
table.stats td:first-child { color: #868e99; white-space: nowrap; }
`;

export function layout(title: string, key: string, body: string): Response {
  const k = encodeURIComponent(key);
  const html = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><div class="wrap">
<header class="top">
  <h1><a href="/?key=${k}" style="color:inherit">Kho lưu voz</a></h1>
  <nav>
    <a href="/?key=${k}">Tất cả</a>
    <a href="/?gone=1&key=${k}">Đã bị xóa</a>
    <a href="/status?key=${k}">Tình trạng</a>
  </nav>
</header>
${body}
</div></body></html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}
