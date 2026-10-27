import { describe, it, expect } from 'vitest';
import { selectCover, autoCoverOnReady, isValidManualCover, type CoverCandidate } from './cover.js';

function m(
  id: string,
  kind: 'photo' | 'video',
  status: CoverCandidate['status'],
  createdAt: string,
  albumId = 'A',
): CoverCandidate {
  return { mediaId: id, albumId, kind, status, createdAt };
}

describe('selectCover', () => {
  it('ready写真の最古を優先', () => {
    const items = [
      m('v1', 'video', 'ready', '2026-01-01T00:00:00Z'),
      m('p2', 'photo', 'ready', '2026-01-03T00:00:00Z'),
      m('p1', 'photo', 'ready', '2026-01-02T00:00:00Z'),
    ];
    expect(selectCover(items)).toBe('p1');
  });
  it('写真が無ければready動画の最古', () => {
    const items = [
      m('v2', 'video', 'ready', '2026-01-02T00:00:00Z'),
      m('v1', 'video', 'ready', '2026-01-01T00:00:00Z'),
    ];
    expect(selectCover(items)).toBe('v1');
  });
  it('ready が無ければ null', () => {
    expect(selectCover([m('p1', 'photo', 'uploading', '2026-01-01T00:00:00Z')])).toBeNull();
    expect(selectCover([])).toBeNull();
  });
});

describe('autoCoverOnReady', () => {
  it('auto かつ未設定なら自動設定', () => {
    const items = [m('p1', 'photo', 'ready', '2026-01-01T00:00:00Z')];
    expect(autoCoverOnReady('auto', null, items)).toBe('p1');
  });
  it('manual は上書きしない', () => {
    const items = [m('p1', 'photo', 'ready', '2026-01-01T00:00:00Z')];
    expect(autoCoverOnReady('manual', null, items)).toBeUndefined();
  });
  it('現在表紙が有効なら維持（undefined）', () => {
    const items = [
      m('p1', 'photo', 'ready', '2026-01-01T00:00:00Z'),
      m('p2', 'photo', 'ready', '2026-01-02T00:00:00Z'),
    ];
    expect(autoCoverOnReady('auto', 'p1', items)).toBeUndefined();
  });
  it('現在表紙が無効化されていれば再選定', () => {
    const items = [
      m('p1', 'photo', 'deleting', '2026-01-01T00:00:00Z'),
      m('p2', 'photo', 'ready', '2026-01-02T00:00:00Z'),
    ];
    expect(autoCoverOnReady('auto', 'p1', items)).toBe('p2');
  });
  it('動画のみで動画が表紙のとき、最初の写真が ready になれば写真に切り替える（要件3-8, 3-9）', () => {
    const items = [
      m('v1', 'video', 'ready', '2026-01-01T00:00:00Z'),
      m('p1', 'photo', 'ready', '2026-01-02T00:00:00Z'),
    ];
    expect(autoCoverOnReady('auto', 'v1', items)).toBe('p1');
  });
  it('表紙が削除されて表示可能なメディアが無くなれば null（プレースホルダ, 要件3-10）', () => {
    const items = [m('p1', 'photo', 'deleting', '2026-01-01T00:00:00Z')];
    expect(autoCoverOnReady('auto', 'p1', items)).toBeNull();
    expect(autoCoverOnReady('auto', null, items)).toBeUndefined(); // もともと null なら変更なし
  });
});

describe('isValidManualCover', () => {
  const items = [
    m('p1', 'photo', 'ready', '2026-01-01T00:00:00Z', 'A'),
    m('v1', 'video', 'ready', '2026-01-01T00:00:00Z', 'A'),
    m('p2', 'photo', 'uploading', '2026-01-01T00:00:00Z', 'A'),
    m('pX', 'photo', 'ready', '2026-01-01T00:00:00Z', 'B'),
  ];
  it('同一アルバム・ready・写真のみ許可', () => {
    expect(isValidManualCover('A', 'p1', items)).toBe(true);
  });
  it('動画は不可', () => {
    expect(isValidManualCover('A', 'v1', items)).toBe(false);
  });
  it('未ready写真は不可', () => {
    expect(isValidManualCover('A', 'p2', items)).toBe(false);
  });
  it('別アルバムのメディアは不可', () => {
    expect(isValidManualCover('A', 'pX', items)).toBe(false);
  });
});
