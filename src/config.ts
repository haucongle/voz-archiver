export const BASE_URL = "https://voz.vn";

/**
 * voz định tuyến theo dạng /f/{slug}.{id}/ nhưng XenForo chỉ đọc phần id,
 * nên slug sai cũng không sao. Giữ slug đúng cho dễ đọc log.
 */
export interface ForumSource {
  id: number;
  slug: string;
  name: string;
}

export const FORUMS: ForumSource[] = [
  { id: 17, slug: "chuyen-tro-linh-tinh%E2%84%A2", name: "Chuyện trò linh tinh" },
  { id: 33, slug: "diem-bao", name: "Điểm báo" },
];

/**
 * voz phục vụ bình thường cho User-Agent trình duyệt. Đổi chuỗi này thành
 * thứ gì đó tự nhận diện được nếu bạn muốn minh bạch với admin diễn đàn.
 */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Nghỉ giữa hai request để giữ tải ở mức một người dùng đang lướt web. */
export const FETCH_DELAY_MS = 700;

/** XenForo mặc định 20 bài mỗi trang. */
export const POSTS_PER_PAGE = 20;
