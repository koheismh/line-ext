import { describe, it, expect, beforeEach } from 'vitest';
import { CopyObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from '../repo/s3Client.js';
import { installMemoryS3, type MemoryS3 } from '../testing/memoryS3.js';
import { metaKeys, mediaKeys } from '../repo/keys.js';
import { startDelete, processDeletionJob, classifyForSweep, expireStaleMedia } from './deletion.js';
import { AppError } from './errors.js';
import type { Album, Group, Media } from '@photo-album/shared';

let mem: MemoryS3;
const ctx = { metaBucket: 'meta', mediaBucket: 'media' };
const base = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

function seedAll(mediaStatus: Media['status'], createdBy = 'member') {
  const group: Group = {
    groupId: 'g1', name: 'f', adminUserIds: ['admin'], memberUserIds: ['admin', 'member'],
    createdBy: 'admin', ...base,
  };
  const album: Album = {
    albumId: 'a1', ownerType: 'group', ownerId: 'g1', title: 't', description: '',
    coverMediaId: null, coverSource: 'auto', createdBy: 'member', ...base,
  };
  const media: Media = {
    mediaId: 'm1', albumId: 'a1', kind: 'photo', status: mediaStatus, errorReason: null,
    originalExt: 'jpg', displayFileName: 'a.jpg', declaredByteSize: 10, declaredMimeType: 'image/jpeg',
    byteSize: 10, mimeType: 'image/jpeg', videoCodec: null, capturedAt: null, fileLastModified: null,
    uploadId: null, createdBy, ...base,
  };
  mem.put(metaKeys.group('g1'), group);
  mem.put(metaKeys.album('group', 'g1', 'a1'), album);
  mem.put(metaKeys.media('a1', 'm1'), media);
  mem.put(metaKeys.mediaLocator('m1'), { albumId: 'a1', ownerType: 'group', ownerId: 'g1' });
  mem.put(metaKeys.albumLocator('a1'), { ownerType: 'group', ownerId: 'g1' });
  // 原本・プレビューの実体を置く
  mem.store.set(mediaKeys.original('a1', 'm1', 'jpg'), { body: 'ORIGINAL', etag: 'o1' });
  mem.store.set(mediaKeys.preview('a1', 'm1'), { body: 'PREVIEW', etag: 'p1' });
}

beforeEach(() => {
  mem = installMemoryS3(s3);
});

describe('startDelete', () => {
  it('投稿者は削除開始でき deleting になり退避先が確定', async () => {
    seedAll('ready');
    const job = await startDelete(ctx, 'm1', 'member', new Date('2026-05-01T00:00:00Z'));
    expect(job).toEqual({ mediaId: 'm1', albumId: 'a1' });
    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('deleting');
    expect(m.trash?.deletedDate).toBe('2026-05-01');
    expect(m.trash?.toKeys[0]).toContain('trash/2026-05-01/');
  });

  it('権限のないメンバーは404', async () => {
    seedAll('ready', 'member');
    await expect(startDelete(ctx, 'm1', 'stranger', new Date())).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 404,
    );
  });

  it('既に deleting は冪等にジョブを返す', async () => {
    seedAll('deleting');
    const job = await startDelete(ctx, 'm1', 'admin', new Date());
    expect(job.mediaId).toBe('m1');
  });
});

describe('processDeletionJob', () => {
  it('コピー→検証→元削除→trashed。trash/ に存在し通常キーは消える', async () => {
    seedAll('ready');
    await startDelete(ctx, 'm1', 'member', new Date('2026-05-01T00:00:00Z'));
    await processDeletionJob(ctx, { mediaId: 'm1', albumId: 'a1' });

    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('trashed');
    expect(m.trash?.movedAt).toBeTruthy();
    // 通常キーは消え、trash にある
    expect(mem.store.has(mediaKeys.original('a1', 'm1', 'jpg'))).toBe(false);
    expect(mem.store.has(mediaKeys.trashOriginal('2026-05-01', 'a1', 'm1', 'jpg'))).toBe(true);
  });

  it('二重実行でも冪等（trashedなら何もしない）', async () => {
    seedAll('ready');
    await startDelete(ctx, 'm1', 'member', new Date('2026-05-01T00:00:00Z'));
    await processDeletionJob(ctx, { mediaId: 'm1', albumId: 'a1' });
    await processDeletionJob(ctx, { mediaId: 'm1', albumId: 'a1' }); // 2回目
    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('trashed');
  });
});

describe('classifyForSweep', () => {
  const now = Date.parse('2026-05-01T12:00:00Z');
  it('deleting が10分以上なら retry_delete', () => {
    expect(classifyForSweep({ status: 'deleting', updatedAt: '2026-05-01T11:00:00Z' }, now)).toBe('retry_delete');
    expect(classifyForSweep({ status: 'deleting', updatedAt: '2026-05-01T11:59:00Z' }, now)).toBe('none');
  });
  it('uploading/validating が24時間以上なら expire', () => {
    expect(classifyForSweep({ status: 'uploading', updatedAt: '2026-04-30T11:00:00Z' }, now)).toBe('expire');
    expect(classifyForSweep({ status: 'validating', updatedAt: '2026-05-01T11:00:00Z' }, now)).toBe('none');
  });
  it('ready は none', () => {
    expect(classifyForSweep({ status: 'ready', updatedAt: '2020-01-01T00:00:00Z' }, now)).toBe('none');
  });
});

describe('expireStaleMedia', () => {
  it('uploading を expired にし、残った原本・プレビューは直接消さずごみ箱へ退避する（要件7-11）', async () => {
    seedAll('uploading');
    await expireStaleMedia(ctx, 'a1', 'm1', new Date('2026-05-02T00:00:00Z'));
    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('expired');
    expect(m.trash?.deletedDate).toBe('2026-05-02');
    expect(m.trash?.movedAt).toBeTruthy();
    expect(mem.store.has(mediaKeys.original('a1', 'm1', 'jpg'))).toBe(false);
    expect(mem.store.has(mediaKeys.trashOriginal('2026-05-02', 'a1', 'm1', 'jpg'))).toBe(true);
  });

  it('ready など失効対象外の状態は変更しない', async () => {
    seedAll('ready');
    await expireStaleMedia(ctx, 'a1', 'm1');
    expect((mem.get(metaKeys.media('a1', 'm1')) as Media).status).toBe('ready');
    expect(mem.store.has(mediaKeys.original('a1', 'm1', 'jpg'))).toBe(true);
  });
});

describe('ごみ箱の不変条件', () => {
  it('コピー先の検証に失敗したら元を消さず、trashed にもしない（再試行に委ねる）', async () => {
    seedAll('ready');
    await startDelete(ctx, 'm1', 'member', new Date('2026-05-01T00:00:00Z'));
    // コピーが実際には行われない障害を再現
    mem.mock.on(CopyObjectCommand).callsFake(() => ({}));
    await expect(processDeletionJob(ctx, { mediaId: 'm1', albumId: 'a1' })).rejects.toThrow();
    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('deleting');
    expect(mem.store.has(mediaKeys.original('a1', 'm1', 'jpg'))).toBe(true);
    expect(mem.store.has(mediaKeys.preview('a1', 'm1'))).toBe(true);
  });

  it('途中で止まっても再実行で続きから完了する（元が既に無いものはスキップ）', async () => {
    seedAll('ready');
    await startDelete(ctx, 'm1', 'member', new Date('2026-05-01T00:00:00Z'));
    // 前回の実行で原本だけ移動済みの状態
    mem.store.set(mediaKeys.trashOriginal('2026-05-01', 'a1', 'm1', 'jpg'), { body: 'ORIGINAL', etag: 'x' });
    mem.store.delete(mediaKeys.original('a1', 'm1', 'jpg'));
    await processDeletionJob(ctx, { mediaId: 'm1', albumId: 'a1' });
    expect((mem.get(metaKeys.media('a1', 'm1')) as Media).status).toBe('trashed');
    expect(mem.store.has(mediaKeys.preview('a1', 'm1'))).toBe(false);
    expect(mem.store.has(mediaKeys.trashPreview('2026-05-01', 'a1', 'm1'))).toBe(true);
  });

  it('error 状態のメディアも投稿者が削除できる（要件7-10）', async () => {
    seedAll('error');
    await startDelete(ctx, 'm1', 'member', new Date('2026-05-01T00:00:00Z'));
    expect((mem.get(metaKeys.media('a1', 'm1')) as Media).status).toBe('deleting');
  });

  it('表紙のメディアを削除すると表紙を再選定する（要件3-10）', async () => {
    seedAll('ready');
    const albumKey = metaKeys.album('group', 'g1', 'a1');
    mem.put(albumKey, { ...(mem.get(albumKey) as Album), coverMediaId: 'm1' });
    await startDelete(ctx, 'm1', 'member', new Date('2026-05-01T00:00:00Z'));
    expect((mem.get(albumKey) as Album).coverMediaId).toBeNull();
  });

  it('他のメンバーが投稿したメディアは削除不可(403)、管理者は削除可', async () => {
    seedAll('ready', 'member');
    const group = mem.get(metaKeys.group('g1')) as Group;
    mem.put(metaKeys.group('g1'), { ...group, memberUserIds: [...group.memberUserIds, 'other'] });
    await expect(startDelete(ctx, 'm1', 'other', new Date())).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 403,
    );
    await expect(startDelete(ctx, 'm1', 'admin', new Date())).resolves.toEqual({ mediaId: 'm1', albumId: 'a1' });
  });
});
