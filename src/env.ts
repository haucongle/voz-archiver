export interface Env {
  DB: D1Database;

  /** Secret. Bắt buộc để mở web UI. Đặt bằng: npx wrangler secret put ARCHIVE_KEY */
  ARCHIVE_KEY?: string;

  MAX_SUBREQUESTS?: string;
  MAX_PAGES_PER_RUN?: string;
  /** Trần trang mỗi thread mỗi lượt, để một thread khổng lồ không bỏ đói phần còn lại. */
  MAX_PAGES_PER_THREAD?: string;
  MAX_NEW_THREADS?: string;
  ACTIVE_WINDOW_HOURS?: string;
  /**
   * "fast" (mặc định) là parser chuỗi. "full" và "text" là hai chế độ
   * HTMLRewriter cũ, giữ lại để /bench đối chiếu — đắt hơn 30–140 lần nên
   * không dùng được trên gói Free.
   */
  PARSE_MODE?: string;
  /** Cứ ngần này phút thì đọc RSS một lần, dù cron chạy mỗi phút. */
  RSS_EVERY_MINUTES?: string;
  /** Chu kỳ cron thật (phút), để chia mốc RSS không rơi vào khoảng cron không bao giờ chạy tới. */
  CRON_EVERY_MINUTES?: string;
  /** Thread còn sống không có hoạt động quá ngần này ngày thì bị dọn khỏi kho. */
  PRUNE_AFTER_DAYS?: string;
  /** Số bài tối đa dọn mỗi lượt cron. Mỗi bài xóa tốn khoảng 4 dòng ghi D1. */
  PRUNE_POSTS_PER_RUN?: string;
}

export function numVar(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
