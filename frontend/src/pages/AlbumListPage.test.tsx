import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import type { AlbumListItem, GroupSummary } from '@photo-album/shared';

// API とセッションはモックする（画面の振る舞いだけを確かめる。認可はサーバ側のテストで確認済み）
const api = vi.hoisted(() => ({
  albums: { list: vi.fn(), create: vi.fn() },
  groups: { list: vi.fn(), create: vi.fn() },
}));
vi.mock('../services/api.js', () => ({
  api,
  errorMessage: (err: unknown, fallback = '通信に失敗しました。') =>
    err instanceof Error ? err.message : fallback,
}));
vi.mock('../store/session.js', () => ({
  useSession: () => ({ userId: 'u1', displayName: 'わたし', loading: false }),
}));

import { AlbumListPage } from './AlbumListPage.js';

function GroupScreen() {
  const { groupId } = useParams();
  return <p>グループの画面 {groupId}</p>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/albums']}>
      <Routes>
        <Route path="/albums" element={<AlbumListPage />} />
        <Route path="/groups/:groupId" element={<GroupScreen />} />
      </Routes>
    </MemoryRouter>,
  );
}

function groupAlbum(albumId: string, groupId: string, title: string): AlbumListItem {
  return {
    albumId,
    ownerType: 'group',
    ownerId: groupId,
    ownerName: '家族',
    title,
    description: '',
    coverMediaId: null,
    coverSource: 'auto',
    coverPreviewUrl: null,
    createdBy: 'u1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

const family: GroupSummary = { groupId: 'g1', name: '家族', memberCount: 3, isAdmin: false };

/** 「新しいアルバム」のフォームに入力して送信する。 */
function submitNewAlbum(values: { title: string; owner?: string; newGroupName?: string }) {
  const card = screen.getByRole('region', { name: '新しいアルバム' });
  fireEvent.change(within(card).getByLabelText('アルバム名'), { target: { value: values.title } });
  if (values.owner) {
    fireEvent.change(within(card).getByLabelText(/^保存先/), { target: { value: values.owner } });
  }
  if (values.newGroupName !== undefined) {
    fireEvent.change(within(card).getByLabelText(/^新しいグループの名前/), {
      target: { value: values.newGroupName },
    });
  }
  fireEvent.click(within(card).getByRole('button', { name: '作成する' }));
}

beforeEach(() => {
  vi.resetAllMocks();
  api.albums.list.mockResolvedValue({ albums: [] });
  api.groups.list.mockResolvedValue({ groups: [] });
});

describe('AlbumListPage', () => {
  it('グループごとにメンバー数とアルバムを表示し、グループの画面へのリンクを出す', async () => {
    api.groups.list.mockResolvedValue({ groups: [family] });
    api.albums.list.mockResolvedValue({ albums: [groupAlbum('a1', 'g1', '旅行')] });
    renderPage();

    const section = await screen.findByRole('region', { name: /家族/ });
    await within(section).findByText('旅行');
    expect(within(section).getByText('3人')).toBeTruthy();
    expect(within(section).getByRole('link', { name: 'グループを開く' }).getAttribute('href')).toBe(
      '/groups/g1',
    );
    expect(screen.getByRole('option', { name: 'グループ「家族」（3人）' })).toBeTruthy();
  });

  it('保存先が「自分だけ」なら個人アルバムを作り、グループは作らない', async () => {
    api.albums.create.mockResolvedValue({});
    renderPage();
    await waitFor(() => expect(api.groups.list).toHaveBeenCalled());

    submitNewAlbum({ title: ' メモ ' });
    await waitFor(() =>
      expect(api.albums.create).toHaveBeenCalledWith({ ownerType: 'user', ownerId: 'u1', title: 'メモ' }),
    );
    expect(api.groups.create).not.toHaveBeenCalled();
  });

  it('「新しいグループを作って共有する」は通常のグループを作ってその中にアルバムを作り、グループの画面へ移る', async () => {
    api.groups.create.mockResolvedValue({ groupId: 'g-new', name: '山田家' });
    api.albums.create.mockResolvedValue({});
    renderPage();
    await waitFor(() => expect(api.groups.list).toHaveBeenCalled());

    submitNewAlbum({ title: '夏の旅行', owner: 'new-group', newGroupName: ' 山田家 ' });

    expect(await screen.findByText('グループの画面 g-new')).toBeTruthy();
    expect(api.groups.create).toHaveBeenCalledWith('山田家');
    expect(api.albums.create).toHaveBeenCalledWith({
      ownerType: 'group',
      ownerId: 'g-new',
      title: '夏の旅行',
    });
  });

  it('グループだけ作れてアルバム作成に失敗したら、保存先をそのグループに切り替え、再試行でグループを二重に作らない', async () => {
    const created: GroupSummary = { groupId: 'g-new', name: '山田家', memberCount: 1, isAdmin: true };
    api.groups.create.mockResolvedValue({ groupId: 'g-new', name: '山田家' });
    api.albums.create.mockRejectedValueOnce(new Error('アルバムを作れませんでした。'));
    renderPage();
    await waitFor(() => expect(api.groups.list).toHaveBeenCalled());
    api.groups.list.mockResolvedValue({ groups: [created] }); // 失敗後の再読み込みでは新しいグループが見える

    submitNewAlbum({ title: '夏の旅行', owner: 'new-group', newGroupName: '山田家' });
    expect(await screen.findByText('アルバムを作れませんでした。')).toBeTruthy();
    const card = screen.getByRole('region', { name: '新しいアルバム' });
    await waitFor(() =>
      expect((within(card).getByLabelText(/^保存先/) as HTMLSelectElement).value).toBe('g-new'),
    );

    api.albums.create.mockResolvedValueOnce({});
    fireEvent.click(within(card).getByRole('button', { name: '作成する' }));
    await waitFor(() => expect(api.albums.create).toHaveBeenCalledTimes(2));
    expect(api.groups.create).toHaveBeenCalledTimes(1);
    expect(api.albums.create).toHaveBeenLastCalledWith({
      ownerType: 'group',
      ownerId: 'g-new',
      title: '夏の旅行',
    });
  });
});
