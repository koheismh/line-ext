// ドメイン型定義（フロント・バックエンド共有）
// design.md「Data Models」に準拠。認可・状態機械の正本となる型。

/** アルバムの所有主体 */
export type OwnerType = 'user' | 'group';

/** メディア種別 */
export type MediaKind = 'photo' | 'video';

/**
 * メディアの状態機械。
 * uploading → validating → ready | error
 * error(preview_failed) → validating（再処理）
 * ready | error → deleting → trashed
 * uploading | validating → expired（放置失効）
 * 状態は後戻りしない（単調に進む）。
 */
export type MediaStatus =
  | 'uploading'
  | 'validating'
  | 'ready'
  | 'error'
  | 'deleting'
  | 'trashed'
  | 'expired';

/** メディアがエラー状態になった理由 */
export type MediaErrorReason = 'invalid_file' | 'preview_failed';

/** コメントの状態 */
export type CommentStatus = 'active' | 'deleted';

/** コメントの対象種別 */
export type CommentTargetType = 'album' | 'media';

/** 内部ユーザー。LINEの sub とは別の内部IDを主キーにする。 */
export interface User {
  /** 内部ID（ULID/UUID） */
  userId: string;
  /** 表示名。初期値はLINE表示名。ログインのたびに更新する。 */
  displayName: string;
  /** ログアウトでインクリメントし、以前の版の署名付きCookieを無効化する。 */
  sessionVersion: number;
  /** UTC ISO 8601 */
  createdAt: string;
}

/** グループ。メンバー・管理者の集合が認可の正本。 */
export interface Group {
  groupId: string;
  /** グループ名（必須、暫定50文字以内） */
  name: string;
  /** 管理者集合（初期は作成者のみ）。将来の追加・移譲に対応するため配列。 */
  adminUserIds: string[];
  /** メンバーの正本 */
  memberUserIds: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 招待。S3キーは sha256(token)。トークン平文は保存しない。
 */
export interface Invite {
  groupId: string;
  /** 失効時刻。期限（暫定7日）とは別に管理者が明示失効できる。 */
  expiresAt: string;
  /** 管理者による失効時刻。未失効は null。 */
  revokedAt: string | null;
  createdBy: string;
  createdAt: string;
}

/** アルバム。1つの所有主体に属する。 */
export interface Album {
  albumId: string;
  ownerType: OwnerType;
  ownerId: string;
  title: string;
  description: string;
  coverMediaId: string | null;
  /** 自動設定が手動設定を上書きしないための区別。 */
  coverSource: 'auto' | 'manual';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 削除退避情報（deleting に移る時点で確定）。 */
export interface MediaTrashInfo {
  /** 退避先の日付プレフィックス（再試行でも変えない）。 */
  deletedDate: string;
  /** コピー元キー群 */
  fromKeys: string[];
  /** コピー先キー群 */
  toKeys: string[];
  /** 退避完了時刻。未完了は null。 */
  movedAt: string | null;
}

/** メディア（写真・動画）の正本。 */
export interface Media {
  /** ULID/UUIDv7（時刻順） */
  mediaId: string;
  albumId: string;
  kind: MediaKind;
  status: MediaStatus;
  /** error のときのみ理由を持つ。 */
  errorReason: MediaErrorReason | null;
  originalExt: string;
  /** 表示用のみ。オブジェクトキーには使わない。 */
  displayFileName: string;
  /** 申告値（署名の Content-Length に使用） */
  declaredByteSize: number;
  /** 申告値（署名の Content-Type に使用） */
  declaredMimeType: string;
  /** 実検証後に確定するサイズ。未確定は null。 */
  byteSize: number | null;
  /** 実検証後に確定するMIME。未確定は null。 */
  mimeType: string | null;
  /** 動画のコーデック（再生可否判定用）。写真や未確定は null。 */
  videoCodec: string | null;
  /** EXIF撮影日時（並べ替え用）。不明は null。 */
  capturedAt: string | null;
  /** File.lastModified（並べ替え・同一ファイル照合用）。不明は null。 */
  fileLastModified: string | null;
  /** マルチパートの uploadId。単一PUTや完了後は null。 */
  uploadId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** 削除時のみ存在。 */
  trash?: MediaTrashInfo;
}

/** コメント。root + children の2階層のみ。 */
export interface Comment {
  /** ULID/UUIDv7（時刻順） */
  commentId: string;
  targetType: CommentTargetType;
  targetId: string;
  /** root 自身は commentId と同一。 */
  rootCommentId: string;
  /** 返信先コメントID（階層は増やさない。誰への返信かの表示用）。 */
  replyToCommentId: string | null;
  /** 本文。墓標（削除済み親）は空文字。 */
  body: string;
  status: CommentStatus;
  authorUserId: string;
  createdAt: string;
  /** 削除時刻。未削除は null。 */
  deletedAt: string | null;
}
