-- Kho lưu trữ thread voz.vn trên Cloudflare D1.
-- Chạy lại nhiều lần được: mọi CREATE đều có IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS threads (
  id             INTEGER PRIMARY KEY,   -- thread id của voz
  slug           TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  forum_id       INTEGER,
  forum_name     TEXT,
  author         TEXT,
  first_seen     INTEGER NOT NULL,      -- unix seconds, lần đầu archiver thấy
  last_activity  INTEGER,               -- pubDate mới nhất từ RSS
  last_crawled   INTEGER,
  pages_seen     INTEGER NOT NULL DEFAULT 0,
  page_count     INTEGER NOT NULL DEFAULT 1,
  post_count     INTEGER NOT NULL DEFAULT 0,
  -- Đánh dấu khi voz trả về 404/403, tức thread đã bị xóa hoặc bị ẩn.
  gone_at        INTEGER,
  gone_status    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_threads_activity ON threads (last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_threads_gone     ON threads (gone_at) WHERE gone_at IS NOT NULL;
-- Các chỉ mục dưới đây để không truy vấn nào phải quét nguyên bảng: D1 Free
-- chỉ cho đọc 5 triệu dòng mỗi ngày và mỗi dòng quét qua đều bị tính.
-- Biểu thức phải khớp từng chữ với ORDER BY trong listView.
CREATE INDEX IF NOT EXISTS idx_threads_recent   ON threads (COALESCE(last_activity, first_seen) DESC);
CREATE INDEX IF NOT EXISTS idx_threads_new      ON threads (id) WHERE gone_at IS NULL AND last_crawled IS NULL;
CREATE INDEX IF NOT EXISTS idx_threads_backlog  ON threads (id) WHERE gone_at IS NULL AND pages_seen < page_count;
CREATE INDEX IF NOT EXISTS idx_threads_live     ON threads (last_activity) WHERE gone_at IS NULL;

CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY,      -- post id của voz, cũng là rowid cho FTS
  thread_id   INTEGER NOT NULL,
  page        INTEGER NOT NULL,
  position    INTEGER,                  -- số thứ tự #N hiển thị trên voz
  author      TEXT,
  posted_at   INTEGER,
  html        TEXT,                     -- nội dung đã lọc, giữ quote và ảnh
  body        TEXT,                     -- bản text thuần để full-text search
  archived_at INTEGER NOT NULL,
  -- Đánh dấu khi bài biến mất khỏi trang mà thread vẫn còn sống.
  gone_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts (thread_id, posted_at, id);
CREATE INDEX IF NOT EXISTS idx_posts_page   ON posts (thread_id, page);
CREATE INDEX IF NOT EXISTS idx_posts_gone   ON posts (thread_id) WHERE gone_at IS NOT NULL;

-- remove_diacritics 2 cho phép gõ không dấu vẫn tìm ra bài có dấu.
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5 (
  body,
  content='posts',
  content_rowid='id',
  tokenize="unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS posts_fts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts (rowid, body) VALUES (new.id, new.body);
END;

CREATE TRIGGER IF NOT EXISTS posts_fts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts (posts_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;

CREATE TRIGGER IF NOT EXISTS posts_fts_au AFTER UPDATE OF body ON posts BEGIN
  INSERT INTO posts_fts (posts_fts, rowid, body) VALUES ('delete', old.id, old.body);
  INSERT INTO posts_fts (rowid, body) VALUES (new.id, new.body);
END;

-- Nhật ký mỗi lượt chạy, để biết archiver có còn sống hay không.
CREATE TABLE IF NOT EXISTS runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  fetches      INTEGER NOT NULL DEFAULT 0,
  new_threads  INTEGER NOT NULL DEFAULT 0,
  new_posts    INTEGER NOT NULL DEFAULT 0,
  gone_found   INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC);
