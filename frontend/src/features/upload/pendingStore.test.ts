import { describe, it, expect } from 'vitest';
import { findMatchingPending, matchesPending, type PendingUpload } from './pendingStore.js';

function pending(id: string, albumId: string, fileName: string, byteSize = 100, lastModified = 1): PendingUpload {
  return {
    id,
    albumId,
    fileName,
    byteSize,
    lastModified,
    mimeType: 'video/mp4',
    reason: 'unknown',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('保留の照合（メモ型, 要件9-5）', () => {
  const file = { name: 'a.mp4', size: 100, lastModified: 1 };

  it('名前・サイズ・更新日時がすべて一致すれば同じファイル', () => {
    expect(matchesPending(pending('1', 'A', 'a.mp4'), file)).toBe(true);
    expect(matchesPending(pending('1', 'A', 'a.mp4', 101), file)).toBe(false);
    expect(matchesPending(pending('1', 'A', 'a.mp4', 100, 2), file)).toBe(false);
    expect(matchesPending(pending('1', 'A', 'b.mp4'), file)).toBe(false);
  });

  it('同じアルバムの保留だけを対象にする（完了時に消す記録の特定）', () => {
    const list = [pending('1', 'A', 'a.mp4'), pending('2', 'B', 'a.mp4'), pending('3', 'A', 'c.mp4')];
    expect(findMatchingPending(list, 'A', file).map((p) => p.id)).toEqual(['1']);
  });
});
