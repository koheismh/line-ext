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

/** 回線ガードの承認抑制期間（ミリ秒）。承認後この間は同種の確認を出さない。 */
export const UPLOAD_GUARD_SUPPRESS_MS = 24 * 60 * 60 * 1000; // 24時間

/** 署名付きURLの有効期限（秒）。用途別。 */
export const SIGNED_URL_TTL_SECONDS = {
  preview: 60 * 60, // 1時間
  original: 5 * 60, // 5分
  video: 30 * 60, // 30分
  download: 5 * 60, // 5分
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

/** マルチパートの並列数（フロント）。 */
export const MULTIPART_CONCURRENCY = 4;
