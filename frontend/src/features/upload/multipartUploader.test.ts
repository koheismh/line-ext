import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  computePartCount,
  sliceForPart,
  uploadParts,
  PART_SIZE,
  type PartUrl,
} from './multipartUploader.js';

afterEach(() => vi.restoreAllMocks());

describe('computePartCount', () => {
  it('サイズからパート数を算出', () => {
    expect(computePartCount(1)).toBe(1);
    expect(computePartCount(PART_SIZE)).toBe(1);
    expect(computePartCount(PART_SIZE + 1)).toBe(2);
    expect(computePartCount(PART_SIZE * 3)).toBe(3);
  });
});

describe('sliceForPart', () => {
  it('パート番号に応じて範囲を切り出す', () => {
    const blob = new Blob([new Uint8Array(PART_SIZE * 2 + 10)]);
    expect(sliceForPart(blob, 1).size).toBe(PART_SIZE);
    expect(sliceForPart(blob, 3).size).toBe(10); // 端数
  });
});

describe('uploadParts', () => {
  function mockFetchOk(etagPrefix = 'etag') {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        void url;
        return {
          ok: true,
          status: 200,
          headers: { get: (h: string) => (h === 'etag' ? `"${etagPrefix}"` : null) },
        };
      }),
    );
  }

  it('全パートをアップロードしETagを昇順で返す', async () => {
    mockFetchOk();
    const blob = new Blob([new Uint8Array(PART_SIZE * 3)]);
    const urls: PartUrl[] = [
      { partNumber: 1, url: 'u1' },
      { partNumber: 2, url: 'u2' },
      { partNumber: 3, url: 'u3' },
    ];
    const progress: number[] = [];
    const parts = await uploadParts(blob, urls, {
      reissue: async () => [],
      onProgress: (done) => progress.push(done),
      sleep: async () => {},
    });
    expect(parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(parts.every((p) => p.etag === 'etag')).toBe(true);
    expect(progress.at(-1)).toBe(3);
  });

  it('403で reissue を呼び、再試行で成功する', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        // 1回目は403、2回目以降は成功
        if (call === 1) {
          return { ok: false, status: 403, headers: { get: () => null } };
        }
        return { ok: true, status: 200, headers: { get: () => '"ok"' } };
      }),
    );
    const reissue = vi.fn(async () => [{ partNumber: 1, url: 'fresh' }]);
    const blob = new Blob([new Uint8Array(100)]);
    const parts = await uploadParts(blob, [{ partNumber: 1, url: 'old' }], {
      reissue,
      sleep: async () => {},
    });
    expect(reissue).toHaveBeenCalledWith([1]);
    expect(parts[0]!.etag).toBe('ok');
  });
});
