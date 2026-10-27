import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { s3 } from '../repo/s3Client.js';
import { installMemoryS3, type MemoryS3 } from '../testing/memoryS3.js';
import { metaKeys } from '../repo/keys.js';
import { listAlbumMedia, getMediaUrl } from './mediaQuery.js';
import { clearSignedUrlCache } from '../repo/mediaObjects.js';
import { AppError } from './errors.js';
import type { Album, Group, Media } from '@photo-album/shared';

let mem: MemoryS3;
const ctx = { metaBucket: 'meta', mediaBucket: 'media' };
const base = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  process.env.AWS_REGION ??= 'ap-northeast-1';
});

function seedAlbum() {
  const group: Group = {
    groupId: 'g1', name: 'f', adminUserIds: ['admin'], memberUserIds: ['admin', 'member', 'owner'],
    createdBy: 'admin', ...base,
  };
  const album: Album = {
    albumId: 'a1', ownerType: 'group', ownerId: 'g1', title: 't', description: '',
    coverMediaId: null, coverSource: 'auto', createdBy: 'owner', ...base,
  };
  mem.put(metaKeys.group('g1'), group);
  mem.put(metaKeys.album('group', 'g1', 'a1'), album);
  mem.put(metaKeys.albumLocator('a1'), { ownerType: 'group', ownerId: 'g1' });
}

function seedMedia(mediaId: string, status: Media['status'], createdBy: string, kind: 'photo' | 'video' = 'photo') {
  const m: Media = {
    mediaId, albumId: 'a1', kind, status, errorReason: status === 'error' ? 'preview_failed' : null,
    originalExt: kind === 'photo' ? 'jpg' : 'mp4', displayFileName: 'f', declaredByteSize: 1,
    declaredMimeType: 'image/jpeg', byteSize: 1, mimeType: kind === 'photo' ? 'image/jpeg' : 'video/mp4',
    videoCodec: null, capturedAt: null, fileLastModified: null, uploadId: null, createdBy,
    createdAt: `2026-01-0${mediaId.length}T00:00:00Z`, updatedAt: '2026-01-01T00:00:00Z',
  };
  mem.put(metaKeys.media('a1', mediaId), m);
  mem.put(metaKeys.mediaLocator(mediaId), { albumId: 'a1', ownerType: 'group', ownerId: 'g1' });
}

beforeEach(() => {
  mem = installMemoryS3(s3);
  clearSignedUrlCache();
  seedAlbum();
});

describe('listAlbumMedia', () => {
  it('ready のみ表示、deleting以降は除外、プレビューURL同梱', async () => {
    seedMedia('r1', 'ready', 'owner');
    seedMedia('d1', 'deleting', 'owner');
    seedMedia('t1', 'trashed', 'owner');
    const page = await listAlbumMedia(ctx, 'a1', 'member');
    expect(page.items.map((i) => i.mediaId)).toEqual(['r1']);
    expect(page.items[0]!.previewUrl).toContain('http');
  });

  it('投稿者本人には処理中/失敗も表示、他人には非表示', async () => {
    seedMedia('r1', 'ready', 'owner');
    seedMedia('e1', 'error', 'owner');
    // 投稿者 owner（状態と理由が分かるので「処理中」と「失敗」を区別して表示できる）
    const ownerView = await listAlbumMedia(ctx, 'a1', 'owner');
    expect(ownerView.items.map((i) => i.mediaId).sort()).toEqual(['e1', 'r1']);
    const failed = ownerView.items.find((i) => i.mediaId === 'e1')!;
    expect(failed.status).toBe('error');
    expect(failed.errorReason).toBe('preview_failed');
    expect(failed.previewUrl).toBeNull();
    // 他メンバー member には ready のみ
    const memberView = await listAlbumMedia(ctx, 'a1', 'member');
    expect(memberView.items.map((i) => i.mediaId)).toEqual(['r1']);
  });

  it('非メンバーは404', async () => {
    seedMedia('r1', 'ready', 'owner');
    await expect(listAlbumMedia(ctx, 'a1', 'stranger')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 404,
    );
  });
});

describe('getMediaUrl', () => {
  it('ready の preview/original URLを発行', async () => {
    seedMedia('r1', 'ready', 'owner');
    expect(await getMediaUrl(ctx, 'r1', 'member', 'preview')).toContain('http');
    expect(await getMediaUrl(ctx, 'r1', 'member', 'original')).toContain('http');
  });

  it('deleting 以降は発行しない（404）', async () => {
    seedMedia('d1', 'deleting', 'owner');
    await expect(getMediaUrl(ctx, 'd1', 'member', 'original')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 404,
    );
  });

  it('video URL は動画のみ、写真に video 指定は422', async () => {
    seedMedia('p1', 'ready', 'owner', 'photo');
    seedMedia('v1', 'ready', 'owner', 'video');
    expect(await getMediaUrl(ctx, 'v1', 'member', 'video')).toContain('http');
    await expect(getMediaUrl(ctx, 'p1', 'member', 'video')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 422,
    );
  });

  it('非メンバーは404', async () => {
    seedMedia('r1', 'ready', 'owner');
    await expect(getMediaUrl(ctx, 'r1', 'stranger', 'preview')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 404,
    );
  });

  it('kind が不正なら422（既定の期限で原本URLを出さない）', async () => {
    seedMedia('r1', 'ready', 'owner');
    await expect(
      getMediaUrl(ctx, 'r1', 'member', 'xxx' as 'preview'),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 422);
  });

  it('download は attachment と元のファイル名を付ける', async () => {
    seedMedia('r1', 'ready', 'owner');
    const url = new URL(await getMediaUrl(ctx, 'r1', 'member', 'download'));
    expect(url.searchParams.get('response-content-disposition')).toBe("attachment; filename*=UTF-8''f");
  });
});
