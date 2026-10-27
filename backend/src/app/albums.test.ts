import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { s3 } from '../repo/s3Client.js';
import { installMemoryS3, type MemoryS3 } from '../testing/memoryS3.js';
import { metaKeys } from '../repo/keys.js';
import { createAlbum, listAlbums, getAlbum, updateAlbum, recalcCover } from './albums.js';
import { AppError } from './errors.js';
import type { Album, Group, Media } from '@photo-album/shared';

let mem: MemoryS3;
const ctx = { metaBucket: 'meta', mediaBucket: 'media' };
const base = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

function seedGroup(id: string, members: string[], admins: string[]): Group {
  const g: Group = {
    groupId: id,
    name: 'g',
    adminUserIds: admins,
    memberUserIds: members,
    createdBy: admins[0]!,
    ...base,
  };
  mem.put(metaKeys.group(id), g);
  return g;
}

function seedMedia(albumId: string, mediaId: string, kind: 'photo' | 'video', status: Media['status'], createdAt: string) {
  const m: Media = {
    mediaId,
    albumId,
    kind,
    status,
    errorReason: null,
    originalExt: kind === 'photo' ? 'jpg' : 'mp4',
    displayFileName: 'f',
    declaredByteSize: 1,
    declaredMimeType: 'image/jpeg',
    byteSize: 1,
    mimeType: 'image/jpeg',
    videoCodec: null,
    capturedAt: null,
    fileLastModified: null,
    uploadId: null,
    createdBy: 'u1',
    createdAt,
    updatedAt: createdAt,
  };
  mem.put(metaKeys.media(albumId, mediaId), m);
}

// 表紙プレビューの署名付きURL生成にはダミー資格情報が必要
beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  process.env.AWS_REGION ??= 'ap-northeast-1';
});

beforeEach(() => {
  mem = installMemoryS3(s3);
});

describe('createAlbum', () => {
  it('個人アルバムを作成し locator も作る', async () => {
    const a = await createAlbum(ctx, 'u1', { ownerType: 'user', ownerId: 'u1', title: 't' }, '2026-01-01T00:00:00Z');
    expect(mem.has(metaKeys.album('user', 'u1', a.albumId))).toBe(true);
    expect(mem.has(metaKeys.albumLocator(a.albumId))).toBe(true);
    expect(a.coverSource).toBe('auto');
  });

  it('他人の個人所有では作成不可(403)', async () => {
    await expect(
      createAlbum(ctx, 'u1', { ownerType: 'user', ownerId: 'other', title: 't' }, 'now'),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 403);
  });

  it('非メンバーのグループ所有では作成不可(403)', async () => {
    seedGroup('g1', ['member'], ['member']);
    await expect(
      createAlbum(ctx, 'stranger', { ownerType: 'group', ownerId: 'g1', title: 't' }, 'now'),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 403);
  });
});

describe('listAlbums', () => {
  it('個人＋所属グループのアルバムを集約（非メンバーのグループは除外）', async () => {
    seedGroup('g1', ['u1'], ['u1']);
    mem.put(metaKeys.userGroup('u1', 'g1'), { groupId: 'g1' });
    await createAlbum(ctx, 'u1', { ownerType: 'user', ownerId: 'u1', title: 'personal' }, '2026-01-01T00:00:00Z');
    await createAlbum(ctx, 'u1', { ownerType: 'group', ownerId: 'g1', title: 'grp' }, '2026-01-01T00:00:00Z');

    const albums = await listAlbums(ctx, 'u1');
    expect(albums.map((a) => a.title).sort()).toEqual(['grp', 'personal']);
  });

  it('user-groups に残骸があっても正本で非メンバーなら除外', async () => {
    seedGroup('g1', ['other'], ['other']); // u1 はメンバーでない
    mem.put(metaKeys.userGroup('u1', 'g1'), { groupId: 'g1' }); // 残骸インデックス
    await createAlbum(ctx, 'other', { ownerType: 'group', ownerId: 'g1', title: 'grp' }, 'now');

    const albums = await listAlbums(ctx, 'u1');
    expect(albums).toHaveLength(0);
  });
});

describe('getAlbum', () => {
  it('所有者は取得、他人は404', async () => {
    const a = await createAlbum(ctx, 'u1', { ownerType: 'user', ownerId: 'u1', title: 't' }, 'now');
    expect((await getAlbum(ctx, a.albumId, 'u1')).albumId).toBe(a.albumId);
    await expect(getAlbum(ctx, a.albumId, 'other')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 404,
    );
  });
});

describe('updateAlbum', () => {
  it('作成者はタイトル変更可', async () => {
    const a = await createAlbum(ctx, 'u1', { ownerType: 'user', ownerId: 'u1', title: 't' }, 'now');
    const updated = await updateAlbum(ctx, a.albumId, 'u1', { title: 'new' }, '2026-02-01T00:00:00Z');
    expect(updated.title).toBe('new');
  });

  it('表紙は同一アルバムの ready 写真のみ。動画や別アルバムは422', async () => {
    const a = await createAlbum(ctx, 'u1', { ownerType: 'user', ownerId: 'u1', title: 't' }, 'now');
    seedMedia(a.albumId, 'p1', 'photo', 'ready', '2026-01-02T00:00:00Z');
    seedMedia(a.albumId, 'v1', 'video', 'ready', '2026-01-03T00:00:00Z');

    const ok = await updateAlbum(ctx, a.albumId, 'u1', { coverMediaId: 'p1' }, 'now');
    expect(ok.coverMediaId).toBe('p1');
    expect(ok.coverSource).toBe('manual');

    await expect(
      updateAlbum(ctx, a.albumId, 'u1', { coverMediaId: 'v1' }, 'now'),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 422);
  });
});

describe('listAlbums（表紙・所有主体名）', () => {
  it('グループ名と、ready の表紙のプレビューURLを同梱する。表紙なしは null', async () => {
    seedGroup('g1', ['u1'], ['u1']);
    mem.put(metaKeys.group('g1'), { ...(mem.get(metaKeys.group('g1')) as Group), name: '家族' });
    mem.put(metaKeys.userGroup('u1', 'g1'), { groupId: 'g1' });
    const personal = await createAlbum(ctx, 'u1', { ownerType: 'user', ownerId: 'u1', title: 'p' }, '2026-01-01T00:00:00Z');
    const grp = await createAlbum(ctx, 'u1', { ownerType: 'group', ownerId: 'g1', title: 'g' }, '2026-01-01T00:00:00Z');
    seedMedia(grp.albumId, 'p1', 'photo', 'ready', '2026-01-02T00:00:00Z');
    await recalcCover(ctx, grp.albumId, 'group', 'g1');

    const albums = await listAlbums(ctx, 'u1');
    const p = albums.find((a) => a.albumId === personal.albumId)!;
    const g = albums.find((a) => a.albumId === grp.albumId)!;
    expect(p.ownerName).toBeNull();
    expect(p.coverPreviewUrl).toBeNull();
    expect(g.ownerName).toBe('家族');
    expect(g.coverPreviewUrl).toContain(`previews/${grp.albumId}/p1/thumbnail.jpg`);
  });
});

describe('createAlbum / updateAlbum の入力検証', () => {
  it('空・長すぎるタイトル、不正な所有主体は422', async () => {
    await expect(
      createAlbum(ctx, 'u1', { ownerType: 'user', ownerId: 'u1', title: '  ' }, 'now'),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 422);
    await expect(
      createAlbum(ctx, 'u1', { ownerType: 'user', ownerId: 'u1', title: 'x'.repeat(101) }, 'now'),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 422);
    await expect(
      createAlbum(ctx, 'u1', { ownerType: 'xxx' as 'user', ownerId: 'u1', title: 't' }, 'now'),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 422);
    const a = await createAlbum(ctx, 'u1', { ownerType: 'user', ownerId: 'u1', title: 't' }, 'now');
    await expect(updateAlbum(ctx, a.albumId, 'u1', { title: '' }, 'now')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 422,
    );
  });

  it('作成者以外の編集は403、閲覧権限なしは404', async () => {
    seedGroup('g1', ['u1', 'u2'], ['u1']);
    const a = await createAlbum(ctx, 'u1', { ownerType: 'group', ownerId: 'g1', title: 't' }, 'now');
    await expect(updateAlbum(ctx, a.albumId, 'u2', { title: 'x' }, 'now')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 403,
    );
    await expect(updateAlbum(ctx, a.albumId, 'stranger', { title: 'x' }, 'now')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 404,
    );
  });

  it('表紙に null を指定すると手動指定を解除して自動選定に戻る', async () => {
    const a = await createAlbum(ctx, 'u1', { ownerType: 'user', ownerId: 'u1', title: 't' }, 'now');
    seedMedia(a.albumId, 'p1', 'photo', 'ready', '2026-01-02T00:00:00Z');
    seedMedia(a.albumId, 'p2', 'photo', 'ready', '2026-01-03T00:00:00Z');
    await updateAlbum(ctx, a.albumId, 'u1', { coverMediaId: 'p2' }, 'now');
    const reset = await updateAlbum(ctx, a.albumId, 'u1', { coverMediaId: null }, 'now');
    expect(reset.coverSource).toBe('auto');
    expect(reset.coverMediaId).toBe('p1');
  });
});

describe('recalcCover', () => {
  it('auto のとき最初の ready 写真を自動設定', async () => {
    const a = await createAlbum(ctx, 'u1', { ownerType: 'user', ownerId: 'u1', title: 't' }, 'now');
    seedMedia(a.albumId, 'p1', 'photo', 'ready', '2026-01-02T00:00:00Z');
    await recalcCover(ctx, a.albumId, 'user', 'u1');
    const album = mem.get(metaKeys.album('user', 'u1', a.albumId)) as Album;
    expect(album.coverMediaId).toBe('p1');
  });

  it('manual 表紙が有効なら据え置き', async () => {
    const a = await createAlbum(ctx, 'u1', { ownerType: 'user', ownerId: 'u1', title: 't' }, 'now');
    seedMedia(a.albumId, 'p1', 'photo', 'ready', '2026-01-02T00:00:00Z');
    seedMedia(a.albumId, 'p2', 'photo', 'ready', '2026-01-03T00:00:00Z');
    await updateAlbum(ctx, a.albumId, 'u1', { coverMediaId: 'p2' }, 'now'); // manual=p2
    await recalcCover(ctx, a.albumId, 'user', 'u1');
    const album = mem.get(metaKeys.album('user', 'u1', a.albumId)) as Album;
    expect(album.coverMediaId).toBe('p2'); // 据え置き
  });

  it('manual 表紙が削除されたら自動に戻し、残存写真→動画→null の順で再選定（要件3-10）', async () => {
    const a = await createAlbum(ctx, 'u1', { ownerType: 'user', ownerId: 'u1', title: 't' }, 'now');
    seedMedia(a.albumId, 'v1', 'video', 'ready', '2026-01-01T00:00:00Z');
    seedMedia(a.albumId, 'p1', 'photo', 'ready', '2026-01-02T00:00:00Z');
    seedMedia(a.albumId, 'p2', 'photo', 'ready', '2026-01-03T00:00:00Z');
    await updateAlbum(ctx, a.albumId, 'u1', { coverMediaId: 'p2' }, 'now');

    seedMedia(a.albumId, 'p2', 'photo', 'deleting', '2026-01-03T00:00:00Z');
    await recalcCover(ctx, a.albumId, 'user', 'u1');
    let album = mem.get(metaKeys.album('user', 'u1', a.albumId)) as Album;
    expect(album.coverMediaId).toBe('p1');
    expect(album.coverSource).toBe('auto');

    seedMedia(a.albumId, 'p1', 'photo', 'deleting', '2026-01-02T00:00:00Z');
    await recalcCover(ctx, a.albumId, 'user', 'u1');
    album = mem.get(metaKeys.album('user', 'u1', a.albumId)) as Album;
    expect(album.coverMediaId).toBe('v1'); // 写真が無ければ動画サムネイル

    seedMedia(a.albumId, 'v1', 'video', 'deleting', '2026-01-01T00:00:00Z');
    await recalcCover(ctx, a.albumId, 'user', 'u1');
    album = mem.get(metaKeys.album('user', 'u1', a.albumId)) as Album;
    expect(album.coverMediaId).toBeNull(); // プレースホルダ
  });
});
