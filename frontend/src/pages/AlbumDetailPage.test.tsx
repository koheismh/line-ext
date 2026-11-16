import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AlbumDetail } from '@photo-album/shared';

// API・セッション・アップロード関連はモックする（画面の振る舞いだけを確かめる。認可はサーバ側のテストで確認済み）
const api = vi.hoisted(() => ({
  albums: { get: vi.fn(), media: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));
vi.mock('../services/api.js', () => ({
  api,
  errorMessage: (err: unknown, fallback = '通信に失敗しました。') =>
    err instanceof Error ? err.message : fallback,
}));
vi.mock('../store/session.js', () => ({
  useSession: () => ({ userId: 'u1', displayName: 'わたし', loading: false }),
}));
vi.mock('../features/upload/useUpload.js', () => ({
  useUpload: () => ({ state: { phase: 'idle' } }),
}));
vi.mock('../features/upload/pendingStore.js', () => ({ listPending: async () => [] }));
vi.mock('../components/UploadPanel.js', () => ({ UploadPanel: () => null }));
vi.mock('../components/CommentPanel.js', () => ({ CommentPanel: () => null }));
vi.mock('../components/MediaViewer.js', () => ({ MediaViewer: () => null }));
vi.mock('../components/MediaGrid.js', () => ({ MediaGrid: () => null, isProcessing: () => false }));

import { AlbumDetailPage } from './AlbumDetailPage.js';

const base = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

function album(overrides: Partial<AlbumDetail> = {}): AlbumDetail {
  return {
    albumId: 'a1',
    ownerType: 'group',
    ownerId: 'g1',
    ownerName: '家族',
    title: '夏の旅行',
    description: '',
    coverMediaId: null,
    coverSource: 'auto',
    createdBy: 'u1',
    canDelete: true,
    ...base,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/albums/a1']}>
      <Routes>
        <Route path="/albums/:albumId" element={<AlbumDetailPage />} />
        <Route path="/albums" element={<p>アルバム一覧の画面</p>} />
        <Route path="/groups/:groupId" element={<p>グループの画面</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  api.albums.media.mockResolvedValue({ items: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AlbumDetailPage のアルバム削除', () => {
  it('削除できない人（canDelete=false）には削除の操作を出さない', async () => {
    api.albums.get.mockResolvedValue(album({ canDelete: false }));
    renderPage();

    await screen.findByRole('heading', { level: 1, name: /夏の旅行/ });
    expect(screen.queryByRole('region', { name: 'アルバムの削除' })).toBeNull();
    expect(screen.queryByRole('button', { name: /アルバムを削除/ })).toBeNull();
  });

  it('確認してから削除し、グループのアルバムはグループの画面へ戻る。やめた場合は削除しない', async () => {
    api.albums.get.mockResolvedValue(album());
    api.albums.remove.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderPage();

    const card = await screen.findByRole('region', { name: 'アルバムの削除' });
    expect(card.textContent).toContain('メンバー全員から見えなくなります');
    const button = within(card).getByRole('button', { name: /アルバムを削除/ });

    fireEvent.click(button);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]![0]).toContain('アルバム「夏の旅行」を削除しますか？');
    expect(confirmSpy.mock.calls[0]![0]).toContain('約30日後に完全に削除されます');
    expect(api.albums.remove).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(await screen.findByText('グループの画面')).toBeTruthy();
    expect(api.albums.remove).toHaveBeenCalledWith('a1');
  });

  it('個人アルバムは削除後にアルバム一覧へ戻る（メンバー全員向けの注意は出さない）', async () => {
    api.albums.get.mockResolvedValue(
      album({ ownerType: 'user', ownerId: 'u1', ownerName: null }),
    );
    api.albums.remove.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();

    const card = await screen.findByRole('region', { name: 'アルバムの削除' });
    expect(card.textContent).not.toContain('メンバー全員');
    fireEvent.click(within(card).getByRole('button', { name: /アルバムを削除/ }));
    expect(await screen.findByText('アルバム一覧の画面')).toBeTruthy();
  });

  it('削除に失敗したら理由を出して画面に残り、もう一度押せる', async () => {
    api.albums.get.mockResolvedValue(album());
    api.albums.remove.mockRejectedValue(new Error('アルバムを削除できるのは、作成者またはグループの管理者のみです。'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();

    const card = await screen.findByRole('region', { name: 'アルバムの削除' });
    fireEvent.click(within(card).getByRole('button', { name: /アルバムを削除/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('作成者またはグループの管理者のみです');
    expect(screen.queryByText('グループの画面')).toBeNull();
    const button = within(screen.getByRole('region', { name: 'アルバムの削除' })).getByRole('button', {
      name: /アルバムを削除/,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});
