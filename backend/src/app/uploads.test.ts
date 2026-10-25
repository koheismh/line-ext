import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { s3 } from '../repo/s3Client.js';
import { installMemoryS3, type MemoryS3 } from '../testing/memoryS3.js';
import { metaKeys } from '../repo/keys.js';
import { initSingleUpload, initMultipartUpload, completeUpload } from './uploads.js';
import { AppError } from './errors.js';
import type { Album, Group, Media } from '@photo-album/shared';

let mem: MemoryS3;
const ctx = { metaBucket: 'meta', mediaBucket: 'media' };
const base = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

// 署名付きURL生成にはダミー資格情報が必要
beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  process.env.AWS_REGION ??= 'ap-northeast-1';
});

function seedGroupAlbum() {
  const group: Group = {
    groupId: 'g1',
    name: 'fam',
    adminUserIds: ['admin'],
    memberUserIds: ['admin', 'member'],
    createdBy: 'admin',
    ...base,
  };
  const album: Album = {
    albumId: 'a1',
    ownerType: 'group',
    ownerId: 'g1',
    title: 't',
    description: '',
    coverMediaId: null,
    coverSource: 'auto',
    createdBy: 'member',
    ...base,
  };
  mem.put(metaKeys.group('g1'), group);
  mem.put(metaKeys.album('group', 'g1', 'a1'), album);
  mem.put(metaKeys.albumLocator('a1'), { ownerType: 'group', ownerId: 'g1' });
}

beforeEach(() => {
  mem = installMemoryS3(s3);
  seedGroupAlbum();
});

describe('initSingleUpload', () => {
  it('メンバーは mediaId・署名URLを得て、uploading のメディアと locator が作られる', async () => {
    const r = await initSingleUpload(ctx, {
      albumId: 'a1',
      userId: 'member',
      declaredMimeType: 'image/jpeg',
      declaredByteSize: 1000,
      displayFileName: 'a.jpg',
      now: '2026-01-01T00:00:00Z',
    });
    expect(r.mediaId).toBeTruthy();
    expect(r.uploadUrl).toContain('http');
    const media = mem.get(metaKeys.media('a1', r.mediaId)) as Media;
    expect(media.status).toBe('uploading');
    expect(mem.has(metaKeys.mediaLocator(r.mediaId))).toBe(true);
  });

  it('非メンバーは404', async () => {
    await expect(
      initSingleUpload(ctx, {
        albumId: 'a1',
        userId: 'stranger',
        declaredMimeType: 'image/jpeg',
        declaredByteSize: 1000,
        displayFileName: 'a.jpg',
        now: 'now',
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 404);
  });

  it('対応外形式は415、容量超過は413', async () => {
    await expect(
      initSingleUpload(ctx, {
        albumId: 'a1',
        userId: 'member',
        declaredMimeType: 'image/heic',
        declaredByteSize: 1000,
        displayFileName: 'a.heic',
        now: 'now',
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 415);

    await expect(
      initSingleUpload(ctx, {
        albumId: 'a1',
        userId: 'member',
        declaredMimeType: 'image/jpeg',
        declaredByteSize: 999_999_999,
        displayFileName: 'a.jpg',
        now: 'now',
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 413);
  });
});

describe('initMultipartUpload / completeUpload', () => {
  it('開始でuploadId・パートURL群、完了でListParts検証しvalidatingへ', async () => {
    const init = await initMultipartUpload(ctx, {
      albumId: 'a1',
      userId: 'member',
      declaredMimeType: 'video/mp4',
      declaredByteSize: 300,
      displayFileName: 'v.mp4',
      now: '2026-01-01T00:00:00Z',
      partCount: 3,
    });
    expect(init.uploadId).toBeTruthy();
    expect(init.partUrls).toHaveLength(3);

    const media0 = mem.get(metaKeys.media('a1', init.mediaId)) as Media;
    expect(media0.uploadId).toBe(init.uploadId);

    // パートの実サイズを設定（合計300＝申告どおり）
    mem.setParts(init.uploadId, [100, 100, 100]);
    await completeUpload(ctx, {
      mediaId: init.mediaId,
      uploadId: init.uploadId,
      userId: 'member',
      parts: [
        { partNumber: 1, etag: 'e1' },
        { partNumber: 2, etag: 'e2' },
        { partNumber: 3, etag: 'e3' },
      ],
      now: '2026-01-02T00:00:00Z',
    });
    const media1 = mem.get(metaKeys.media('a1', init.mediaId)) as Media;
    expect(media1.status).toBe('validating');
  });

  it('完了時に合計サイズが申告超過なら413', async () => {
    const init = await initMultipartUpload(ctx, {
      albumId: 'a1',
      userId: 'member',
      declaredMimeType: 'video/mp4',
      declaredByteSize: 300,
      displayFileName: 'v.mp4',
      now: 'now',
      partCount: 2,
    });
    mem.setParts(init.uploadId, [500, 500]); // 合計1000 > 申告300
    await expect(
      completeUpload(ctx, {
        mediaId: init.mediaId,
        uploadId: init.uploadId,
        userId: 'member',
        parts: [
          { partNumber: 1, etag: 'e1' },
          { partNumber: 2, etag: 'e2' },
        ],
        now: 'now',
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 413);
  });
});
