// メディア状態機械（純粋関数）。
// design.md「設計上の重要判断」「Correctness Properties」に準拠。
//
// 遷移規則:
//   uploading  → validating | expired
//   validating → ready | error | expired
//   ready      → deleting
//   error      → validating（preview_failed のときのみ＝再処理） | deleting
//   deleting   → trashed
//   trashed    → （終端）
//   expired    → （終端）
// 状態は後戻りしない（単調に進む）。再処理は error(preview_failed) のみ許可。

import type { MediaStatus, MediaErrorReason } from '@photo-album/shared';

/** 許可された遷移の隣接表。error からの分岐は理由で追加判定する。 */
const ALLOWED: Record<MediaStatus, MediaStatus[]> = {
  uploading: ['validating', 'expired'],
  validating: ['ready', 'error', 'expired'],
  ready: ['deleting'],
  error: ['validating', 'deleting'],
  deleting: ['trashed'],
  trashed: [],
  expired: [],
};

/** 一覧などで「一般表示してよい」状態か。 */
export function isPubliclyVisible(status: MediaStatus): boolean {
  return status === 'ready';
}

/** 署名付きURL（original/video）を発行してよい状態か。 */
export function canIssueMediaUrl(status: MediaStatus): boolean {
  return status === 'ready';
}

/** 削除開始できる状態か（ready と error を許可）。 */
export function canStartDelete(status: MediaStatus): boolean {
  return status === 'ready' || status === 'error';
}

/**
 * 状態遷移が許可されるか判定する。
 * @param from 現在の状態
 * @param to 遷移先
 * @param errorReason from が 'error' のときの理由（再処理可否の判定に使用）
 */
export function canTransition(
  from: MediaStatus,
  to: MediaStatus,
  errorReason?: MediaErrorReason | null,
): boolean {
  if (!ALLOWED[from].includes(to)) {
    return false;
  }
  // error → validating（再処理）は preview_failed のときのみ許可。
  // invalid_file はファイル自体が不正なので再処理しても直らない。
  if (from === 'error' && to === 'validating') {
    return errorReason === 'preview_failed';
  }
  return true;
}

/**
 * S3イベント処理をskipすべき状態か（冪等・単調性）。
 * deleting/trashed/expired/error(invalid_file) は処理しない。
 */
export function shouldSkipProcessing(
  status: MediaStatus,
  errorReason?: MediaErrorReason | null,
): boolean {
  if (status === 'deleting' || status === 'trashed' || status === 'expired') {
    return true;
  }
  if (status === 'error' && errorReason === 'invalid_file') {
    return true;
  }
  return false;
}
