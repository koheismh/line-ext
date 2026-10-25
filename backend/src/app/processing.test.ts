import { describe, it, expect, beforeEach } from 'vitest';
import { s3 } from '../repo/s3Client.js';
import { installMemoryS3, type MemoryS3 } from '../testing/memoryS3.js';
import { metaKeys } from '../repo/keys.js';
import { processUploadedMedia, type MediaProcessor, type ValidationOutcome } from './processing.js';
import type { Media } from '@photo-album/shared';

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
  return m;
}

function processorOk(): MediaProcessor {
  return {
    validate: async (): Promise<ValidationOutcome> => ({
      ok: true,
      byteSize: 100,
      mimeType: 'image/jpeg',
      videoCodec: null,
      capturedAt: null,
    }),
    generatePreview: async () => {},
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

  it('プレビュー生成失敗で error(preview_failed)', async () => {
    seedMedia('validating');
    const processor: MediaProcessor = {
      validate: processorOk().validate,
      generatePreview: async () => {
        throw new Error('ffmpeg failed');
      },
    };
    await processUploadedMedia(ctx, 'a1', 'm1', processor);
    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('error');
    expect(m.errorReason).toBe('preview_failed');
  });

  it('削除系(deleting)は skip され ready に戻さない（単調性）', async () => {
    seedMedia('deleting');
    await processUploadedMedia(ctx, 'a1', 'm1', processorOk());
    const m = mem.get(metaKeys.media('a1', 'm1')) as Media;
    expect(m.status).toBe('deleting');
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
});
