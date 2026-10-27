import { describe, it, expect, beforeEach } from 'vitest';
import { CopyObjectCommand } from '@aws-sdk/client-s3';
import { s3 } from '../repo/s3Client.js';
import { installMemoryS3, type MemoryS3 } from '../testing/memoryS3.js';
import { metaKeys, mediaKeys } from '../repo/keys.js';
import {
  processUploadedMedia,
  requestReprocess,
  type MediaProcessor,
  type ValidationOutcome,
} from './processing.js';
import { AppError } from './errors.js';
import type { Album, Media } from '@photo-album/shared';

let mem: MemoryS3;
const ctx = { metaBucket: 'meta', mediaBucket: 'media' };

function seedMedia(status: Media['status'], overrides: Partial<Media> = {}): Media {
  const m: Media = {
    mediaId: 'm1',
    albumId: 'a1',
    kind: 'photo',
    status,
    errorReason: null,
    originalExt: 'jpg',
    displayFileName: 'a.jpg',
    declaredByteSize: 100,
    declaredMimeType: 'image/jpeg',
    byteSize: null,
    mimeType: null,
    videoCodec: null,
    capturedAt: null,
    fileLastModified: null,
    uploadId: null,
    createdBy: 'u1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
  mem.put(metaKeys.media('a1', 'm1'), m);
  mem.put(metaKeys.mediaLocator('m1'), { albumId: 'a1', ownerType: 'user', ownerId: 'u1' });
  return m;
}

function seedAlbum(overrides: Partial<Album> = {}): void {
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
    ...overrides,
  };
  mem.put(metaKeys.album('user', 'u1', 'a1'), album);
  mem.put(metaKeys.albumLocator('a1'), { ownerType: 'user', ownerId: 'u1' });
}

function processorOk(onPreview?: () => void): MediaProcessor {
  return {
    validate: async (): Promise<ValidationOutcome> => ({
      ok: true,
      byteSize: 100,
      mimeType: 'image/jpeg',
      videoCodec: null,
      capturedAt: null,
    }),
    generatePreview: async () => {
      // プレビューを書いたことにする
      mem.store.set(mediaKeys.preview('a1', 'm1'), { body: 'PREVIEW', etag: 'p' });
      onPreview?.();
    },
  };
}

beforeEach(() => {
  mem = installMemoryS3(s3);
});

describe('processUploadedMedia', () => {
  it('検証成功＋プレビュー成功で ready になり実測値が入る', async () => {
    seedMedia('validating');
    await processUploadedMedia(ctx, 'a1', 'm1', processorOk());
    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('ready');
    expect(m.byteSize).toBe(100);
    expect(m.mimeType).toBe('image/jpeg');
  });

  it('単一PUT（uploading のままS3に到着）も validating を経て ready になる', async () => {
    seedMedia('uploading');
    await processUploadedMedia(ctx, 'a1', 'm1', processorOk());
    expect((mem.get(metaKeys.media('a1', 'm1')) as Media).status).toBe('ready');
  });

  it('検証失敗で error(invalid_file)、プレビューは呼ばれない', async () => {
    seedMedia('validating');
    let previewCalled = false;
    const processor: MediaProcessor = {
      validate: async () => ({ ok: false, byteSize: null, mimeType: null, videoCodec: null, capturedAt: null }),
      generatePreview: async () => {
        previewCalled = true;
      },
    };
    await processUploadedMedia(ctx, 'a1', 'm1', processor);
    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('error');
    expect(m.errorReason).toBe('invalid_file');
    expect(previewCalled).toBe(false);
  });

  it('プレビュー生成失敗で error(preview_failed)、再処理イベントで ready に回復する', async () => {
    seedMedia('validating');
    const failing: MediaProcessor = {
      validate: processorOk().validate,
      generatePreview: async () => {
        throw new Error('ffmpeg failed');
      },
    };
    await processUploadedMedia(ctx, 'a1', 'm1', failing);
    let m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('error');
    expect(m.errorReason).toBe('preview_failed');

    // 再処理（error(preview_failed) → validating → ready）
    await processUploadedMedia(ctx, 'a1', 'm1', processorOk());
    m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('ready');
    expect(m.errorReason).toBeNull();
  });

  it('削除系(deleting)は skip され ready に戻さない（単調性）', async () => {
    seedMedia('deleting');
    await processUploadedMedia(ctx, 'a1', 'm1', processorOk());
    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('deleting');
  });

  it('プレビュー生成中に削除されたら ready にせず、書いたプレビューを片付ける', async () => {
    seedMedia('validating');
    const processor = processorOk(() => {
      // 生成中に利用者が削除した
      const cur = mem.get(metaKeys.media('a1', 'm1')) as Media;
      mem.put(metaKeys.media('a1', 'm1'), { ...cur, status: 'deleting' });
    });
    await processUploadedMedia(ctx, 'a1', 'm1', processor);
    expect((mem.get(metaKeys.media('a1', 'm1')) as Media).status).toBe('deleting');
    expect(mem.has(mediaKeys.preview('a1', 'm1'))).toBe(false);
  });

  it('error(invalid_file) は skip（再処理しない）', async () => {
    seedMedia('error', { errorReason: 'invalid_file' });
    await processUploadedMedia(ctx, 'a1', 'm1', processorOk());
    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('error');
    expect(m.errorReason).toBe('invalid_file');
  });

  it('既に ready なら何もしない（冪等）', async () => {
    seedMedia('ready');
    await processUploadedMedia(ctx, 'a1', 'm1', processorOk());
    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('ready');
  });

  it('最初の写真が ready になると自動表紙に設定される（要件3-8）', async () => {
    seedAlbum();
    seedMedia('validating');
    await processUploadedMedia(ctx, 'a1', 'm1', processorOk());
    const album = mem.get(metaKeys.album('user', 'u1', 'a1')) as Album;
    expect(album.coverMediaId).toBe('m1');
    expect(album.coverSource).toBe('auto');
  });

  it('手動表紙は自動設定で上書きされない', async () => {
    seedAlbum({ coverSource: 'manual', coverMediaId: 'manual-cover' });
    // 手動表紙のメディアも ready で存在する
    mem.put(metaKeys.media('a1', 'manual-cover'), {
      ...seedMedia('ready'),
      mediaId: 'manual-cover',
    });
    seedMedia('validating');
    await processUploadedMedia(ctx, 'a1', 'm1', processorOk());
    const album = mem.get(metaKeys.album('user', 'u1', 'a1')) as Album;
    expect(album.coverMediaId).toBe('manual-cover');
  });
});

describe('requestReprocess', () => {
  it('投稿者は error(preview_failed) を再処理でき、原本の上書きコピーでイベントを再発火する', async () => {
    seedAlbum();
    seedMedia('error', { errorReason: 'preview_failed' });
    mem.store.set(mediaKeys.original('a1', 'm1', 'jpg'), { body: 'ORIGINAL', etag: 'o' });
    await requestReprocess(ctx, 'm1', 'u1');
    const calls = mem.mock.commandCalls(CopyObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.Key).toBe(mediaKeys.original('a1', 'm1', 'jpg'));
    expect(calls[0]!.args[0].input.MetadataDirective).toBe('REPLACE');
  });

  it('invalid_file・ready は再処理できない(409)、閲覧権限なしは404', async () => {
    seedAlbum();
    seedMedia('error', { errorReason: 'invalid_file' });
    await expect(requestReprocess(ctx, 'm1', 'u1')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 409,
    );
    seedMedia('ready');
    await expect(requestReprocess(ctx, 'm1', 'u1')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 409,
    );
    await expect(requestReprocess(ctx, 'm1', 'stranger')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 404,
    );
  });
});
