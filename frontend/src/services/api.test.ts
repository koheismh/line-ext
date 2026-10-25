import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiClientError } from './api.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    })),
  );
}

describe('api client', () => {
  it('成功時はJSONを返す', async () => {
    mockFetch(200, { userId: 'u1' });
    expect(await api.me()).toEqual({ userId: 'u1' });
  });

  it('エラー時は ApiClientError を status/code 付きで投げる', async () => {
    mockFetch(404, { code: 'not_found', message: '見つかりません' });
    await expect(api.albums.get('x')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ApiClientError && e.status === 404 && e.code === 'not_found',
    );
  });

  it('204は本文なしで解決', async () => {
    mockFetch(204, undefined);
    await expect(api.comments.remove('c1')).resolves.toBeUndefined();
  });
});
