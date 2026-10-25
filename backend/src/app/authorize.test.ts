import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Album, Group, Media } from '@photo-album/shared';
import type { JsonRecord } from '../repo/index.js';

// entities をモックして、locator/S3 を介さず正本を差し込む
vi.mock('./entities.js', () => ({
  getAlbumByLocator: vi.fn(),
  getMediaByLocator: vi.fn(),
  getGroup: vi.fn(),
}));

import {
  authorizeAlbumView,
  authorizeAlbumEdit,
  authorizeUpload,
  authorizeMediaView,
  authorizeMediaDelete,
} from './authorize.js';
import { getAlbumByLocator, getMediaByLocator, getGroup } from './entities.js';
import { AppError } from './errors.js';

const ctx = { metaBucket: 'meta', mediaBucket: 'media' };
const base = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

function rec<T>(value: T): JsonRecord<T> {
  return { value, etag: 'e' };
}

const group: Group = {
  groupId: 'g1',
  name: 'fam',
  adminUserIds: ['admin'],
  memberUserIds: ['admin', 'member'],
  createdBy: 'admin',
  ...base,
};

function groupAlbum(createdBy: string): Album {
  return {
    albumId: 'a1',
    ownerType: 'group',
    ownerId: 'g1',
    title: 't',
    description: '',
    coverMediaId: null,
    coverSource: 'auto',
    createdBy,
    ...base,
  };
}

function media(createdBy: string): Media {
  return {
    mediaId: 'm1',
    albumId: 'a1',
    kind: 'photo',
    status: 'ready',
    errorReason: null,
    originalExt: 'jpg',
    displayFileName: 'a.jpg',
    declaredByteSize: 1,
    declaredMimeType: 'image/jpeg',
    byteSize: 1,
    mimeType: 'image/jpeg',
    videoCodec: null,
    capturedAt: null,
    fileLastModified: null,
    uploadId: null,
    createdBy,
    ...base,
  };
}

beforeEach(() => {
  vi.mocked(getAlbumByLocator).mockReset();
  vi.mocked(getMediaByLocator).mockReset();
  vi.mocked(getGroup).mockReset();
});

async function expectStatus(p: Promise<unknown>, status: number) {
  await expect(p).rejects.toSatisfy(
    (e: unknown) => e instanceof AppError && e.status === status,
  );
}

describe('authorizeAlbumView', () => {
  it('メンバーは閲覧可', async () => {
    vi.mocked(getAlbumByLocator).mockResolvedValue(rec(groupAlbum('member')));
    vi.mocked(getGroup).mockResolvedValue(rec(group));
    const access = await authorizeAlbumView(ctx, 'a1', 'member');
    expect(access.album.value.albumId).toBe('a1');
  });

  it('非メンバーは404（存在を隠す）', async () => {
    vi.mocked(getAlbumByLocator).mockResolvedValue(rec(groupAlbum('member')));
    vi.mocked(getGroup).mockResolvedValue(rec(group));
    await expectStatus(authorizeAlbumView(ctx, 'a1', 'stranger'), 404);
  });

  it('locator/正本が無ければ404', async () => {
    vi.mocked(getAlbumByLocator).mockResolvedValue(null);
    await expectStatus(authorizeAlbumView(ctx, 'a1', 'member'), 404);
  });
});

describe('authorizeAlbumEdit', () => {
  it('作成者は編集可', async () => {
    vi.mocked(getAlbumByLocator).mockResolvedValue(rec(groupAlbum('member')));
    vi.mocked(getGroup).mockResolvedValue(rec(group));
    await expect(authorizeAlbumEdit(ctx, 'a1', 'member')).resolves.toBeTruthy();
  });
  it('作成者でないメンバーは403', async () => {
    vi.mocked(getAlbumByLocator).mockResolvedValue(rec(groupAlbum('member')));
    vi.mocked(getGroup).mockResolvedValue(rec(group));
    await expectStatus(authorizeAlbumEdit(ctx, 'a1', 'admin'), 403);
  });
});

describe('authorizeUpload', () => {
  it('メンバーは可、非メンバーは404（閲覧不可）', async () => {
    vi.mocked(getAlbumByLocator).mockResolvedValue(rec(groupAlbum('member')));
    vi.mocked(getGroup).mockResolvedValue(rec(group));
    await expect(authorizeUpload(ctx, 'a1', 'member')).resolves.toBeTruthy();
    await expectStatus(authorizeUpload(ctx, 'a1', 'stranger'), 404);
  });
});

describe('authorizeMediaView / Delete', () => {
  it('メンバーは閲覧可', async () => {
    vi.mocked(getMediaByLocator).mockResolvedValue(rec(media('member')));
    vi.mocked(getAlbumByLocator).mockResolvedValue(rec(groupAlbum('member')));
    vi.mocked(getGroup).mockResolvedValue(rec(group));
    const access = await authorizeMediaView(ctx, 'm1', 'member');
    expect(access.media.value.mediaId).toBe('m1');
  });

  it('削除は投稿者か管理者のみ、他メンバーは403', async () => {
    vi.mocked(getMediaByLocator).mockResolvedValue(rec(media('member')));
    vi.mocked(getAlbumByLocator).mockResolvedValue(rec(groupAlbum('member')));
    vi.mocked(getGroup).mockResolvedValue(rec(group));
    // 投稿者
    await expect(authorizeMediaDelete(ctx, 'm1', 'member')).resolves.toBeTruthy();
    // 管理者
    await expect(authorizeMediaDelete(ctx, 'm1', 'admin')).resolves.toBeTruthy();
    // 無関係メンバー（memberUserIdsにいない）→ 閲覧不可で404
    await expectStatus(authorizeMediaDelete(ctx, 'm1', 'stranger'), 404);
  });

  it('メディアが無ければ404', async () => {
    vi.mocked(getMediaByLocator).mockResolvedValue(null);
    await expectStatus(authorizeMediaView(ctx, 'm1', 'member'), 404);
  });
});
