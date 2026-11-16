import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Album, MediaListItem } from '@photo-album/shared';

// API とセッションはモックする（画面の振る舞いだけを確かめる。認可はサーバ側のテストで確認済み）
const api = vi.hoisted(() => ({
  media: { url: vi.fn() },
}));
vi.mock('../services/api.js', () => ({
  api,
  errorMessage: (err: unknown, fallback = '通信に失敗しました。') =>
    err instanceof Error ? err.message : fallback,
}));
vi.mock('../store/session.js', () => ({
  useSession: () => ({ userId: 'u1', displayName: 'わたし', loading: false }),
}));
vi.mock('./CommentPanel.js', () => ({ CommentPanel: () => null }));

import { MediaViewer } from './MediaViewer.js';

const album: Album = {
  albumId: 'a1',
  ownerType: 'user',
  ownerId: 'u1',
  title: 't',
  description: '',
  coverMediaId: null,
  coverSource: 'auto',
  createdBy: 'u1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function photo(id: string): MediaListItem {
  return {
    mediaId: id,
    albumId: 'a1',
    kind: 'photo',
    status: 'ready',
    errorReason: null,
    previewUrl: null,
    displayFileName: `${id}.jpg`,
    videoCodec: null,
    createdBy: 'u1',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

/** タッチ・マウスの移動を再現する（jsdom には PointerEvent が無いため、座標を持つイベントを作る）。 */
function pointer(type: 'pointerdown' | 'pointerup' | 'pointercancel', x: number, y: number) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { clientX: x, clientY: y, pointerId: 1, isPrimary: true });
  return ev;
}

/** 写真の上で、指をドラッグして離す。 */
function flick(img: HTMLElement, from: [number, number], to: [number, number]) {
  fireEvent(img, pointer('pointerdown', from[0], from[1]));
  fireEvent(img, pointer('pointerup', to[0], to[1]));
}

function renderViewer(props: {
  current: string;
  ids: string[];
  hasMore?: boolean;
  onSelect?: (m: MediaListItem) => void;
  onLoadMore?: () => void;
}) {
  const items = props.ids.map(photo);
  const current = items.find((m) => m.mediaId === props.current)!;
  const onSelect = props.onSelect ?? vi.fn();
  const onLoadMore = props.onLoadMore ?? vi.fn();
  const ui = (list: MediaListItem[], cur: MediaListItem) => (
    <MediaViewer
      media={cur}
      album={album}
      items={list}
      hasMore={props.hasMore ?? false}
      onSelect={onSelect}
      onLoadMore={onLoadMore}
      onClose={() => {}}
      onChanged={() => {}}
    />
  );
  const view = render(ui(items, current));
  const altText = `${props.current}.jpg`;
  return {
    onSelect,
    onLoadMore,
    rerenderWith: (list: MediaListItem[], cur: MediaListItem) => view.rerender(ui(list, cur)),
    /** 署名付きURLが届いて写真が出るまで待ち、その要素を返す。 */
    stage: () => screen.findByAltText(altText),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  api.media.url.mockImplementation(async (id: string) => ({ url: `https://signed/${id}` }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MediaViewer の前後移動（横フリック）', () => {
  it('左へフリックすると次の写真、右へフリックすると前の写真へ移る', async () => {
    const v = renderViewer({ current: 'b', ids: ['a', 'b', 'c'] });
    const img = await v.stage();
    flick(img, [200, 100], [120, 104]); // 左へ80px
    expect(v.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ mediaId: 'c' }));
    flick(img, [100, 100], [180, 100]); // 右へ80px
    expect(v.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ mediaId: 'a' }));
  });

  it('短い動きや縦の動きでは移らない', async () => {
    const v = renderViewer({ current: 'b', ids: ['a', 'b', 'c'] });
    const img = await v.stage();
    flick(img, [200, 100], [180, 100]); // 20px しか動いていない
    flick(img, [200, 100], [190, 260]); // 縦に大きく動いている
    expect(v.onSelect).not.toHaveBeenCalled();
  });

  it('最初の写真で右へ、最後の写真で左へフリックしても何も起きない（続きも無いとき）', async () => {
    const first = renderViewer({ current: 'a', ids: ['a', 'b'] });
    flick(await first.stage(), [100, 100], [200, 100]);
    expect(first.onSelect).not.toHaveBeenCalled();
    expect(first.onLoadMore).not.toHaveBeenCalled();
  });

  it('一覧の最後で続きがあれば、続きを読み込んでから次の写真へ移る', async () => {
    const v = renderViewer({ current: 'b', ids: ['a', 'b'], hasMore: true });
    flick(await v.stage(), [200, 100], [120, 100]);
    expect(v.onLoadMore).toHaveBeenCalledTimes(1);
    expect(v.onSelect).not.toHaveBeenCalled(); // まだ読み込み中

    // 続きが届いた（読み込んだ分の先頭＝次の写真）
    v.rerenderWith([photo('a'), photo('b'), photo('c'), photo('d')], photo('b'));
    expect(v.onSelect).toHaveBeenCalledTimes(1);
    expect(v.onSelect).toHaveBeenCalledWith(expect.objectContaining({ mediaId: 'c' }));
  });

  it('続きが届かないときは次へ移らない', async () => {
    const v = renderViewer({ current: 'b', ids: ['a', 'b'], hasMore: true });
    flick(await v.stage(), [200, 100], [120, 100]);
    v.rerenderWith([photo('a'), photo('b')], photo('b')); // 件数が増えなかった
    expect(v.onSelect).not.toHaveBeenCalled();
  });
});

describe('MediaViewer の表示の切り替え', () => {
  it('移った先の写真の URL を取り直し、前の写真の URL は使わない', async () => {
    const v = renderViewer({ current: 'a', ids: ['a', 'b'] });
    expect((await v.stage()).getAttribute('src')).toBe('https://signed/a');

    v.rerenderWith([photo('a'), photo('b')], photo('b'));
    await waitFor(() => expect(api.media.url).toHaveBeenCalledWith('b', 'original'));
    await waitFor(() => expect(screen.getByAltText('b.jpg').getAttribute('src')).toBe('https://signed/b'));
  });

  it('前の写真の URL 取得が遅れて届いても、いま表示中の写真は差し替えない', async () => {
    let resolveA: (v: { url: string }) => void = () => {};
    api.media.url.mockImplementation((id: string) =>
      id === 'a'
        ? new Promise((resolve) => (resolveA = resolve))
        : Promise.resolve({ url: `https://signed/${id}` }),
    );
    const v = renderViewer({ current: 'a', ids: ['a', 'b'] });
    v.rerenderWith([photo('a'), photo('b')], photo('b'));
    await waitFor(() => expect(screen.getByAltText('b.jpg').getAttribute('src')).toBe('https://signed/b'));
    resolveA({ url: 'https://signed/a-late' }); // 古い応答が後から届く
    await Promise.resolve();
    expect(screen.getByAltText('b.jpg').getAttribute('src')).toBe('https://signed/b');
  });

  it('移動できる写真がないときは案内を出さない', async () => {
    const v = renderViewer({ current: 'a', ids: ['a'] });
    await v.stage();
    expect(screen.queryByText(/左右にスワイプすると/)).toBeNull();
  });
});
