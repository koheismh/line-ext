import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { AlbumListItem, Group } from '@photo-album/shared';

// API とセッションはモックする（画面の振る舞いだけを確かめる。認可はサーバ側のテストで確認済み）
const api = vi.hoisted(() => ({
  albums: { list: vi.fn(), create: vi.fn() },
  groups: {
    detail: vi.fn(),
    invites: vi.fn(),
    issueInvite: vi.fn(),
    revokeInvite: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
  },
}));
vi.mock('../services/api.js', () => ({
  api,
  errorMessage: (err: unknown, fallback = '通信に失敗しました。') =>
    err instanceof Error ? err.message : fallback,
}));
vi.mock('../store/session.js', () => ({
  useSession: () => ({ userId: 'u1', displayName: 'わたし', loading: false }),
}));

import { GroupPage } from './GroupPage.js';

const base = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

function group(adminUserIds: string[]): Group {
  return {
    groupId: 'g1',
    name: '家族',
    adminUserIds,
    memberUserIds: ['u1', 'u2'],
    createdBy: adminUserIds[0]!,
    ...base,
  };
}

const members = [
  { userId: 'u1', displayName: 'わたし' },
  { userId: 'u2', displayName: 'ともだち' },
];

function album(albumId: string, title: string): AlbumListItem {
  return {
    albumId,
    ownerType: 'group',
    ownerId: 'g1',
    ownerName: '家族',
    title,
    description: '',
    coverMediaId: null,
    coverSource: 'auto',
    coverPreviewUrl: null,
    createdBy: 'u2',
    ...base,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/groups/g1']}>
      <Routes>
        <Route path="/groups/:groupId" element={<GroupPage />} />
        <Route path="/albums" element={<p>アルバム一覧の画面</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  api.groups.invites.mockResolvedValue({ invites: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GroupPage', () => {
  it('このグループのアルバムとメンバーを表示する（メンバーでも管理者でなければ招待の操作は出さない）', async () => {
    api.groups.detail.mockResolvedValue({ group: group(['u9']), members });
    api.albums.list.mockResolvedValue({ albums: [album('a1', '旅行')] });
    renderPage();

    const albums = await screen.findByRole('region', { name: 'このグループのアルバム' });
    expect(within(albums).getByRole('link', { name: /旅行/ }).getAttribute('href')).toBe('/albums/a1');
    expect(api.albums.list).toHaveBeenCalledWith('g1');
    expect(screen.getByText('ともだち')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /招待URLを発行/ })).toBeNull();
    expect(api.groups.invites).not.toHaveBeenCalled();
  });

  it('ここで作るアルバムはこのグループのものになり、作成後に一覧へ出る', async () => {
    api.groups.detail.mockResolvedValue({ group: group(['u1']), members });
    api.albums.list.mockResolvedValueOnce({ albums: [] });
    api.albums.create.mockResolvedValue({});
    renderPage();

    const card = await screen.findByRole('region', { name: 'アルバムを作る' });
    api.albums.list.mockResolvedValue({ albums: [album('a2', '運動会')] });
    fireEvent.change(within(card).getByLabelText('アルバム名'), { target: { value: ' 運動会 ' } });
    fireEvent.click(within(card).getByRole('button', { name: '作成する' }));

    await waitFor(() =>
      expect(api.albums.create).toHaveBeenCalledWith({
        ownerType: 'group',
        ownerId: 'g1',
        title: '運動会',
      }),
    );
    const albums = screen.getByRole('region', { name: 'このグループのアルバム' });
    expect(await within(albums).findByText('運動会')).toBeTruthy();
  });

  it('管理者でなければ「グループの設定」（名前の変更・削除）は出さない', async () => {
    api.groups.detail.mockResolvedValue({ group: group(['u9']), members });
    api.albums.list.mockResolvedValue({ albums: [] });
    renderPage();

    await screen.findByRole('region', { name: 'このグループのアルバム' });
    expect(screen.queryByRole('region', { name: 'グループの設定' })).toBeNull();
    expect(screen.queryByRole('button', { name: /グループを削除/ })).toBeNull();
  });

  it('管理者はグループ名を変えられ、見出しが新しい名前になる', async () => {
    api.groups.detail.mockResolvedValue({ group: group(['u1']), members });
    api.albums.list.mockResolvedValue({ albums: [] });
    api.groups.rename.mockResolvedValue({ ...group(['u1']), name: '山田家' });
    renderPage();

    const settings = await screen.findByRole('region', { name: 'グループの設定' });
    const input = within(settings).getByLabelText(/^グループ名/) as HTMLInputElement;
    expect(input.value).toBe('家族');
    const submit = within(settings).getByRole('button', { name: '名前を変える' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // 変更していないうちは押せない

    fireEvent.change(input, { target: { value: ' 山田家 ' } });
    fireEvent.click(submit);

    await waitFor(() => expect(api.groups.rename).toHaveBeenCalledWith('g1', '山田家'));
    expect(await screen.findByRole('heading', { level: 1, name: /山田家/ })).toBeTruthy();
    expect(screen.getByText('グループ名を変更しました。')).toBeTruthy();
  });

  it('アルバムがあるグループは削除ボタンを押せず、理由を出す', async () => {
    api.groups.detail.mockResolvedValue({ group: group(['u1']), members });
    api.albums.list.mockResolvedValue({ albums: [album('a1', '旅行')] });
    renderPage();

    const settings = await screen.findByRole('region', { name: 'グループの設定' });
    await within(screen.getByRole('region', { name: 'このグループのアルバム' })).findByText('旅行');
    const button = within(settings).getByRole('button', { name: /グループを削除/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(within(settings).getByText(/アルバムがあるグループは削除できません/)).toBeTruthy();
  });

  it('アルバムのないグループは、確認してから削除し、アルバム一覧へ戻る。やめた場合は削除しない', async () => {
    api.groups.detail.mockResolvedValue({ group: group(['u1']), members });
    api.albums.list.mockResolvedValue({ albums: [] });
    api.groups.remove.mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderPage();

    const settings = await screen.findByRole('region', { name: 'グループの設定' });
    const button = within(settings).getByRole('button', { name: /グループを削除/ });
    fireEvent.click(button);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]![0]).toContain('グループ「家族」を削除しますか？');
    expect(api.groups.remove).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(await screen.findByText('アルバム一覧の画面')).toBeTruthy();
    expect(api.groups.remove).toHaveBeenCalledWith('g1');
  });

  it('削除を断られたら（例: 直前にアルバムが作られた）理由を出して画面に残る', async () => {
    api.groups.detail.mockResolvedValue({ group: group(['u1']), members });
    api.albums.list.mockResolvedValue({ albums: [] });
    api.groups.remove.mockRejectedValue(new Error('アルバムがあるグループは削除できません。'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();

    const settings = await screen.findByRole('region', { name: 'グループの設定' });
    fireEvent.click(within(settings).getByRole('button', { name: /グループを削除/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('アルバムがあるグループは削除できません。');
    expect(screen.queryByText('アルバム一覧の画面')).toBeNull();
  });

  it('メンバーでないグループ（404）はエラーを表示し、中身を出さない', async () => {
    api.groups.detail.mockRejectedValue(new Error('対象が見つかりません。'));
    api.albums.list.mockRejectedValue(new Error('対象が見つかりません。'));
    renderPage();

    expect(await screen.findByText('対象が見つかりません。')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'このグループのアルバム' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'アルバムを作る' })).toBeNull();
  });
});
