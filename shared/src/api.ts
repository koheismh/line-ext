// API入出力の共有型。エラー型はフロント・バックエンドで共有する。

/**
 * 機械可読なエラー。
 * - code: フロントが分岐に使う機械可読コード
 * - message: 画面に出す利用者向け説明
 */
export interface ApiError {
  code: string;
  message: string;
}

/** 署名付きURLの用途。用途ごとに有効期限が異なる。 */
export type SignedUrlKind = 'preview' | 'original' | 'video' | 'download';

/** メディア一覧の1件（プレビューURLを同梱して返す）。 */
export interface MediaListItem {
  mediaId: string;
  albumId: string;
  kind: 'photo' | 'video';
  /** プレビュー署名付きURL（暫定1時間、同一メディアは期限内再利用）。 */
  previewUrl: string | null;
  createdAt: string;
}

/** マルチパート開始の応答。 */
export interface MultipartInit {
  mediaId: string;
  uploadId: string;
  /** パート番号→署名付きURL。 */
  partUrls: { partNumber: number; url: string }[];
}
