// API入出力の共有型。エラー型はフロント・バックエンドで共有する。

import type { Album, Comment, MediaErrorReason, MediaStatus } from './domain.js';

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

/** 署名付きURLの用途として正しい値か（クエリ検証用）。 */
export function isSignedUrlKind(value: unknown): value is SignedUrlKind {
  return value === 'preview' || value === 'original' || value === 'video' || value === 'download';
}

/** GET /api/me の応答。 */
export interface MeResponse {
  userId: string;
  displayName: string;
}

/** メディア一覧の1件（プレビューURLを同梱して返す）。 */
export interface MediaListItem {
  mediaId: string;
  albumId: string;
  kind: 'photo' | 'video';
  /** ready 以外（uploading/validating/error）は投稿者本人にのみ返る。 */
  status: MediaStatus;
  /** status=error のときの理由。 */
  errorReason: MediaErrorReason | null;
  /** プレビュー署名付きURL（暫定1時間、同一メディアは期限内再利用）。ready 以外は null。 */
  previewUrl: string | null;
  /** 表示用ファイル名。 */
  displayFileName: string;
  /** 動画のコーデック（判定できた場合のみ）。再生できない可能性の表示に使う。 */
  videoCodec: string | null;
  /** 投稿者の内部ユーザーID（再処理ボタン等の表示判定用。認可はサーバ側で行う）。 */
  createdBy: string;
  createdAt: string;
}

/** メディア一覧の応答（ページング）。 */
export interface MediaPage {
  items: MediaListItem[];
  nextToken?: string;
}

/** アルバム一覧の1件。表紙プレビューURLと所有主体名を同梱する。 */
export interface AlbumListItem extends Album {
  /** 表紙のプレビュー署名付きURL。表紙なし・未生成は null（プレースホルダ表示）。 */
  coverPreviewUrl: string | null;
  /** group 所有ならグループ名。個人アルバムは null。 */
  ownerName: string | null;
}

/** 所属グループの概要（GET /api/groups）。 */
export interface GroupSummary {
  groupId: string;
  name: string;
  /** 要求者が管理者か（表示制御用。認可はサーバ側で行う）。 */
  isAdmin: boolean;
}

/** 有効な招待の概要（管理者向け。トークン平文は含まない）。 */
export interface InviteSummary {
  inviteId: string;
  expiresAt: string;
  createdAt: string;
}

/** コメントのスレッド表示（root + 表示可能な子）。 */
export interface CommentThread {
  root: Comment;
  /** 墓標の root を表示するか（子がある場合 true）。 */
  showRoot: boolean;
  children: Comment[];
}

/** コメント一覧の応答（root 単位のページング）。 */
export interface CommentListResponse {
  threads: CommentThread[];
  /** 投稿者の userId → 表示名。 */
  authors: Record<string, string>;
  /** 要求者が他人のコメントを削除できるか（グループ管理者）。表示制御用。 */
  canModerate: boolean;
  nextToken?: string;
}

/** マルチパート開始の応答。 */
export interface MultipartInit {
  mediaId: string;
  uploadId: string;
  /** パート番号→署名付きURL。 */
  partUrls: { partNumber: number; url: string }[];
}
