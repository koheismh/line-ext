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
 * 自動表紙（coverSource='auto'）の更新先を判定する。メディアが ready になった/削除された際に呼ぶ。
 * - 手動設定（'manual'）は上書きしない
 * - 現在の表紙が ready の写真なら維持する
 * - それ以外（未設定・削除済み・動画）は再選定する。動画表紙は写真が ready になった時点で写真に切り替わる（要件3-8, 3-9）
 * - ready のメディアが無くなれば null（プレースホルダ, 要件3-10）
 * @returns 更新すべき coverMediaId（null=表紙なし）。更新不要なら undefined。
 */
export function autoCoverOnReady(
  coverSource: 'auto' | 'manual',
  currentCoverMediaId: string | null,
  items: CoverCandidate[],
): string | null | undefined {
  if (coverSource === 'manual') return undefined;
  const current = currentCoverMediaId
    ? items.find((m) => m.mediaId === currentCoverMediaId)
    : undefined;
  if (current && current.status === 'ready' && current.kind === 'photo') {
    return undefined;
  }
  const selected = selectCover(items);
  return selected === currentCoverMediaId ? undefined : selected;
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
