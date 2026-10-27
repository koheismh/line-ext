// 暫定値の定数。要件の「後から変更できる暫定事項」に対応。
// 設定で変更しやすいよう1か所に集約する。

/** 対応ファイル形式（MIME） */
export const SUPPORTED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime', // MOV(H.264)
] as const;

/** 容量上限（バイト） */
export const MAX_PHOTO_BYTES = 50 * 1024 * 1024; // 50MB
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024; // 500MB

/** 大容量ガードの閾値（バイト）。単体/合計ともこの値で判定。 */
export const LARGE_UPLOAD_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50MB

/** マルチパートを使う閾値（バイト）。単一ファイルがこれ以上、または動画ならマルチパート。 */
export const MULTIPART_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50MB

/** S3 マルチパートの最小パートサイズ（最終パートを除く）。パート数の上限検証に使う。 */
export const MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024; // 5MiB

/** 回線ガードの承認抑制期間（ミリ秒）。承認後この間は同種の確認を出さない。 */
export const UPLOAD_GUARD_SUPPRESS_MS = 24 * 60 * 60 * 1000; // 24時間

/** 署名付きURLの有効期限（秒）。用途別。 */
export const SIGNED_URL_TTL_SECONDS = {
  preview: 60 * 60, // 1時間
  original: 5 * 60, // 5分
  video: 30 * 60, // 30分
  download: 5 * 60, // 5分
} as const;

/**
 * アップロード用署名付きURLの有効期限（秒）。参照用（original 5分）とは別に管理する（要件4-15）。
 * S3 は期限をリクエスト受信時に判定するため、送信開始までに間に合えばよい。
 */
export const UPLOAD_URL_TTL_SECONDS = {
  single: 15 * 60, // 単一PUT: 15分
  part: 60 * 60, // マルチパートの各パート: 1時間（期限切れは再発行APIで継続）
} as const;

/** 招待URLの有効期限（ミリ秒）。 */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7日

/** 放置メディアの失効時間（ミリ秒）。 */
export const STALE_MEDIA_TTL_MS = 24 * 60 * 60 * 1000; // 24時間

/** deleting の自動再試行閾値（ミリ秒）。 */
export const DELETING_RETRY_THRESHOLD_MS = 10 * 60 * 1000; // 10分

/** ごみ箱保管日数。 */
export const TRASH_RETENTION_DAYS = 30;

/** 未完了マルチパート破棄までの日数。 */
export const ABORT_INCOMPLETE_MULTIPART_DAYS = 1;

/** グループ名の最大文字数。 */
export const GROUP_NAME_MAX_LENGTH = 50;

/** アルバムのタイトル・説明の最大文字数（暫定）。 */
export const ALBUM_TITLE_MAX_LENGTH = 100;
export const ALBUM_DESCRIPTION_MAX_LENGTH = 1000;

/** コメント本文の最大文字数（暫定）。 */
export const COMMENT_BODY_MAX_LENGTH = 2000;

/** コメント一覧の1ページあたりの root 数（暫定）。 */
export const COMMENT_ROOTS_PAGE_SIZE = 20;

/**
 * セッションCookieの Max-Age（秒）。
 * 要件1-6「無期限」を満たすため、ブラウザ終了で消えるセッションCookieにはせず、
 * ブラウザ上限（Chrome は400日）の長期Cookieとし、/api/me のたびに延長する。
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** マルチパートの並列数（フロント）。 */
export const MULTIPART_CONCURRENCY = 4;
