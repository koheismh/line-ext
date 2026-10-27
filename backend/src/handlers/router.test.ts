import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { s3 } from '../repo/s3Client.js';
import { installMemoryS3, type MemoryS3 } from '../testing/memoryS3.js';
import { metaKeys } from '../repo/keys.js';
import { ConflictError } from '../repo/errors.js';
import { signSession } from '../auth/session.js';
import { route } from './router.js';
import { errorToResponse } from './http.js';
import type { RuntimeConfig } from './runtimeConfig.js';
import type { Album, Group, Media, User } from '@photo-album/shared';

const ORIGIN = 'https://app.example.com';
const SECRET = 'test-cookie-secret';
const QUEUE_URL = 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/deletion';
const base = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

const cfg: RuntimeConfig = {
  app: { metaBucket: 'meta', mediaBucket: 'media' },
  allowedOrigin: ORIGIN,
  lineCallbackUrl: `${ORIGIN}/api/auth/line/callback`,
  deletionQueueUrl: QUEUE_URL,
  secrets: { cookieSecret: SECRET, lineChannelId: 'cid', lineChannelSecret: 'csecret' },
};

let mem: MemoryS3;
const sqsMock = mockClient(SQSClient);

function event(
  method: string,
  path: string,
  opts: { cookie?: string; origin?: string; body?: unknown; query?: Record<string, string> } = {},
): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    requestContext: { http: { method } },
    headers: opts.origin ? { origin: opts.origin } : {},
    cookies: opts.cookie ? [opts.cookie] : [],
    queryStringParameters: opts.query,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function seedUser(userId: string, sessionVersion = 0): string {
  const u: User = { userId, displayName: `name-${userId}`, sessionVersion, createdAt: base.createdAt };
  mem.put(metaKeys.user(userId), u);
  return `session=${signSession({ userId, sessionVersion }, SECRET)}`;
}

beforeEach(() => {
  mem = installMemoryS3(s3);
  sqsMock.reset();
  sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm' });
});

describe('認証・セッション', () => {
  it('Cookie なしの保護APIは401', async () => {
    const res = await route(event('GET', '/api/me'), cfg);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).code).toBe('unauthorized');
  });

  it('/api/me は表示名を返し、セッションCookieを延長する', async () => {
    const cookie = seedUser('u1');
    const res = await route(event('GET', '/api/me', { cookie }), cfg);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ userId: 'u1', displayName: 'name-u1' });
    expect(res.cookies?.[0]).toContain('Max-Age=');
  });

  it('ログアウト後は同じ署名付きCookieを再利用しても拒否される（受け入れテスト13）', async () => {
    const cookie = seedUser('u1');
    const out = await route(event('POST', '/api/auth/logout', { cookie, origin: ORIGIN }), cfg);
    expect(out.statusCode).toBe(200);
    expect(out.cookies?.[0]).toContain('Max-Age=0');
    const res = await route(event('GET', '/api/me', { cookie }), cfg);
    expect(res.statusCode).toBe(401);
  });

  it('ログアウトも変更系なので Origin が違えば403（CSRF）', async () => {
    const cookie = seedUser('u1');
    const res = await route(event('POST', '/api/auth/logout', { cookie, origin: 'https://evil.example' }), cfg);
    expect(res.statusCode).toBe(403);
    expect((mem.get(metaKeys.user('u1')) as User).sessionVersion).toBe(0);
  });

  it('変更系APIは Origin 不一致・欠落で403', async () => {
    const cookie = seedUser('u1');
    const bad = await route(event('POST', '/api/groups', { cookie, origin: 'https://evil.example', body: { name: 'g' } }), cfg);
    expect(bad.statusCode).toBe(403);
    const missing = await route(event('POST', '/api/groups', { cookie, body: { name: 'g' } }), cfg);
    expect(missing.statusCode).toBe(403);
    const ok = await route(event('POST', '/api/groups', { cookie, origin: ORIGIN, body: { name: 'g' } }), cfg);
    expect(ok.statusCode).toBe(201);
  });

  it('ボディがオブジェクトでなければ422', async () => {
    const cookie = seedUser('u1');
    const res = await route(event('POST', '/api/groups', { cookie, origin: ORIGIN, body: ['x'] }), cfg);
    expect(res.statusCode).toBe(422);
  });
});

describe('メディア削除（非同期）', () => {
  function seedMedia() {
    const group: Group = {
      groupId: 'g1', name: 'f', adminUserIds: ['u1'], memberUserIds: ['u1'], createdBy: 'u1', ...base,
    };
    const album: Album = {
      albumId: 'a1', ownerType: 'group', ownerId: 'g1', title: 't', description: '',
      coverMediaId: null, coverSource: 'auto', createdBy: 'u1', ...base,
    };
    const media: Media = {
      mediaId: 'm1', albumId: 'a1', kind: 'photo', status: 'ready', errorReason: null, originalExt: 'jpg',
      displayFileName: 'a.jpg', declaredByteSize: 1, declaredMimeType: 'image/jpeg', byteSize: 1,
      mimeType: 'image/jpeg', videoCodec: null, capturedAt: null, fileLastModified: null, uploadId: null,
      createdBy: 'u1', ...base,
    };
    mem.put(metaKeys.group('g1'), group);
    mem.put(metaKeys.album('group', 'g1', 'a1'), album);
    mem.put(metaKeys.albumLocator('a1'), { ownerType: 'group', ownerId: 'g1' });
    mem.put(metaKeys.media('a1', 'm1'), media);
    mem.put(metaKeys.mediaLocator('m1'), { albumId: 'a1', ownerType: 'group', ownerId: 'g1' });
  }

  it('DELETE は deleting にして202を返し、削除ジョブを SQS に投入する', async () => {
    const cookie = seedUser('u1');
    seedMedia();
    const res = await route(event('DELETE', '/api/media/m1', { cookie, origin: ORIGIN }), cfg);
    expect(res.statusCode).toBe(202);
    expect((mem.get(metaKeys.media('a1', 'm1')) as Media).status).toBe('deleting');
    const calls = sqsMock.commandCalls(SendMessageCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.QueueUrl).toBe(QUEUE_URL);
    expect(JSON.parse(calls[0]!.args[0].input.MessageBody!)).toEqual({ mediaId: 'm1', albumId: 'a1' });
  });

  it('SQS 投入に失敗しても削除は受理される（定期掃除が再投入する）', async () => {
    const cookie = seedUser('u1');
    seedMedia();
    sqsMock.on(SendMessageCommand).rejects(new Error('sqs down'));
    const res = await route(event('DELETE', '/api/media/m1', { cookie, origin: ORIGIN }), cfg);
    expect(res.statusCode).toBe(202);
  });

  it('URL発行の kind が不正なら422', async () => {
    const cookie = seedUser('u1');
    seedMedia();
    const res = await route(event('GET', '/api/media/m1/url', { cookie, query: { kind: 'xxx' } }), cfg);
    expect(res.statusCode).toBe(422);
  });
});

describe('errorToResponse', () => {
  it('ETag 競合は409（リトライ可能）として返す', () => {
    const res = errorToResponse(new ConflictError());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe('conflict');
  });

  it('想定外のエラーは詳細を出さず500', () => {
    const res = errorToResponse(new Error('secret detail'));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret detail');
  });
});
