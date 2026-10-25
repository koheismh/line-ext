// アルバム表紙の自動選定・再選定・手動設定の検証（純粋関数）。
// design.md「表紙の自動選定」に準拠。

import type { Media } from '@photo-album/shared';

/** 表紙選定に用いるメディアの最小情報。 */
export interface CoverCandidate {
  mediaId: string;
  albumId: string;
  kind: 'photo' | 'video';
  status: Media['status'];
  createdAt: string;
}

/** createdAt 昇順で最初に条件を満たすものを返す。 */
function firstBy(
  items: CoverCandidate[],
  pred: (m: CoverCandidate) => boolean,
): CoverCandidate | null {
  const sorted = [...items].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return sorted.find(pred) ?? null;
}

/**
 * 表紙を再選定する。
 * 優先順: ready の写真（最古） → ready の動画（最古） → null（プレースホルダ）
 */
export function selectCover(items: CoverCandidate[]): string | null {
  const photo = firstBy(items, (m) => m.status === 'ready' && m.kind === 'photo');
  if (photo) return photo.mediaId;
  const video = firstBy(items, (m) => m.status === 'ready' && m.kind === 'video');
  if (video) return video.mediaId;
  return null;
}

/**
 * 新しい写真が ready になったときの自動表紙設定を判定する。
 * coverSource が 'auto' かつ現在表紙が未設定/無効な場合のみ自動更新する。
 * 手動設定（'manual'）は上書きしない。
 * @returns 更新すべき coverMediaId。更新不要なら undefined。
 */
export function autoCoverOnReady(
  coverSource: 'auto' | 'manual',
  currentCoverMediaId: string | null,
  items: CoverCandidate[],
): string | undefined {
  if (coverSource === 'manual') return undefined;
  // 現在の表紙が ready で存在するなら維持
  if (
    currentCoverMediaId &&
    items.some((m) => m.mediaId === currentCoverMediaId && m.status === 'ready')
  ) {
    return undefined;
  }
  const selected = selectCover(items);
  return selected === currentCoverMediaId ? undefined : (selected ?? undefined);
}

/**
 * 手動で指定された表紙が妥当か検証する。
 * 条件: 同一アルバム・status=ready・kind=photo。
 */
export function isValidManualCover(
  albumId: string,
  mediaId: string,
  items: CoverCandidate[],
): boolean {
  const m = items.find((x) => x.mediaId === mediaId);
  return !!m && m.albumId === albumId && m.status === 'ready' && m.kind === 'photo';
}
