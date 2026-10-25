// 容量判定ユーティリティ（フロント）。requirements 要件4-21/4-22 準拠。
// shared の定数を再利用し、一括=合計・単体=単体で大容量判定する。

import { LARGE_UPLOAD_THRESHOLD_BYTES, UPLOAD_GUARD_SUPPRESS_MS } from '@photo-album/shared';

export { UPLOAD_GUARD_SUPPRESS_MS };

/**
 * 大容量ガードの対象か。
 * - 単体（fileCount===1）: そのサイズで判定
 * - 一括（複数）: 合計サイズで判定
 */
export function isLargeUploadThreshold(totalBytes: number, fileCount: number): boolean {
  if (fileCount <= 0) return false;
  return totalBytes >= LARGE_UPLOAD_THRESHOLD_BYTES;
}

/** 複数ファイルの合計サイズ。 */
export function sumSizes(sizes: number[]): number {
  return sizes.reduce((a, b) => a + b, 0);
}
