import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';
import { MULTIPART_MIN_PART_BYTES } from '@photo-album/shared';
import { s3 } from '../repo/s3Client.js';
import { installMemoryS3, type MemoryS3 } from '../testing/memoryS3.js';
import { metaKeys } from '../repo/keys.js';
import { initSingleUpload, initMultipartUpload, completeUpload, reissuePartUrls } from './uploads.js';
import { AppError } from './errors.js';
import type { Album, Group, Media } from '@photo-album/shared';

let mem: MemoryS3;
const ctx = { metaBucket: 'meta', mediaBucket: 'media' };
const base = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
const PART = MULTIPART_MIN_PART_BYTES;

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
    memberUserIds: ['admin', 'member', 'other'],
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

async function startMultipart(declaredByteSize: number, partCount: number) {
  return initMultipartUpload(ctx, {
    albumId: 'a1',
    userId: 'member',
    declaredMimeType: 'video/mp4',
    declaredByteSize,
    displayFileName: 'v.mp4',
    now: '2026-01-01T00:00:00Z',
    partCount,
  });
}

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
    const url = new URL(r.uploadUrl);
    // Content-Type / Content-Length を署名に含め、空データのチェックサムを埋め込まない（要件4-3）
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    expect([...url.searchParams.keys()].some((k) => k.toLowerCase().includes('checksum'))).toBe(false);
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

  it('対応外形式は415、容量超過は413、ファイル名不正は422', async () => {
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

    await expect(
      initSingleUpload(ctx, {
        albumId: 'a1',
        userId: 'member',
        declaredMimeType: 'image/jpeg',
        declaredByteSize: 1000,
        displayFileName: '',
        now: 'now',
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 422);
  });
});

describe('initMultipartUpload / completeUpload', () => {
  it('開始でuploadId・パートURL群、完了はサーバ側 ListParts のETagで行い validating へ', async () => {
    const init = await startMultipart(PART * 3, 3);
    expect(init.uploadId).toBeTruthy();
    expect(init.partUrls).toHaveLength(3);

    const media0 = mem.get(metaKeys.media('a1', init.mediaId)) as Media;
    expect(media0.uploadId).toBe(init.uploadId);

    // パートの実サイズを設定（合計＝申告どおり）
    mem.setParts(init.uploadId, [PART, PART, PART]);
    await completeUpload(ctx, {
      mediaId: init.mediaId,
      uploadId: init.uploadId,
      userId: 'member',
      now: '2026-01-02T00:00:00Z',
    });
    const media1 = mem.get(metaKeys.media('a1', init.mediaId)) as Media;
    expect(media1.status).toBe('validating');
    // Complete にはクライアント申告ではなく ListParts の ETag が使われる
    expect(mem.completed.get(init.uploadId)).toEqual([
      { PartNumber: 1, ETag: '"etag-1"' },
      { PartNumber: 2, ETag: '"etag-2"' },
      { PartNumber: 3, ETag: '"etag-3"' },
    ]);
  });

  it('完了の二重実行は冪等に成功する', async () => {
    const init = await startMultipart(PART * 2, 2);
    mem.setParts(init.uploadId, [PART, PART]);
    const p = { mediaId: init.mediaId, uploadId: init.uploadId, userId: 'member', now: 'now' };
    await completeUpload(ctx, p);
    await expect(completeUpload(ctx, p)).resolves.toBeUndefined(); // ListParts はもう呼べないが成功扱い
    expect((mem.get(metaKeys.media('a1', init.mediaId)) as Media).status).toBe('validating');
  });

  it('完了直後にS3イベント処理が状態を進めていても、validating に巻き戻さない（単調性）', async () => {
    const init = await startMultipart(PART * 2, 2);
    mem.setParts(init.uploadId, [PART, PART]);
    const key = metaKeys.media('a1', init.mediaId);
    // CompleteMultipartUpload の直後にイベント処理が ready まで進めた状況を再現
    mem.mock.on(CompleteMultipartUploadCommand).callsFake(() => {
      const m = mem.get(key) as Media;
      mem.put(key, { ...m, status: 'ready' });
      return {};
    });
    await completeUpload(ctx, { mediaId: init.mediaId, uploadId: init.uploadId, userId: 'member', now: 'now' });
    expect((mem.get(key) as Media).status).toBe('ready');
  });

  it('完了時に合計サイズが申告超過なら413、不足なら422（申告不一致を拒否, 要件4-4）', async () => {
    const over = await startMultipart(PART * 2, 2);
    mem.setParts(over.uploadId, [PART, PART + 1]);
    await expect(
      completeUpload(ctx, { mediaId: over.mediaId, uploadId: over.uploadId, userId: 'member', now: 'now' }),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 413);

    const under = await startMultipart(PART * 2, 2);
    mem.setParts(under.uploadId, [PART]);
    await expect(
      completeUpload(ctx, { mediaId: under.mediaId, uploadId: under.uploadId, userId: 'member', now: 'now' }),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 422);
    expect((mem.get(metaKeys.media('a1', under.mediaId)) as Media).status).toBe('uploading');
  });

  it('パート数が申告サイズに対して多すぎれば422', async () => {
    await expect(startMultipart(PART * 2, 3)).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 422,
    );
  });

  it('他人のアップロードの完了・パート再発行は403', async () => {
    const init = await startMultipart(PART * 2, 2);
    mem.setParts(init.uploadId, [PART, PART]);
    await expect(
      completeUpload(ctx, { mediaId: init.mediaId, uploadId: init.uploadId, userId: 'other', now: 'now' }),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 403);
    await expect(
      reissuePartUrls(ctx, { mediaId: init.mediaId, uploadId: init.uploadId, userId: 'other', partNumbers: [1] }),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 403);
    // 本人は再発行できる
    const urls = await reissuePartUrls(ctx, {
      mediaId: init.mediaId,
      uploadId: init.uploadId,
      userId: 'member',
      partNumbers: [2],
    });
    expect(urls.map((u) => u.partNumber)).toEqual([2]);
  });
});
