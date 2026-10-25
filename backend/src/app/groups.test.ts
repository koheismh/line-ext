import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { s3 } from '../repo/s3Client.js';
import {
  createGroup,
  getGroupDetail,
  issueInvite,
  revokeInvite,
  acceptInvite,
} from './groups.js';
import { AppError } from './errors.js';
import { metaKeys, sha256Hex } from '../repo/keys.js';
import type { User } from '@photo-album/shared';

const s3mock = mockClient(s3);
const ctx = { metaBucket: 'meta', mediaBucket: 'media' };

/**
 * インメモリS3。キー→JSON文字列。
 * 条件付き書き込み(IfNoneMatch:* / IfMatch)を簡易再現する。
 */
let store: Map<string, { body: string; etag: string }>;
let etagSeq: number;

function setupMock() {
  store = new Map();
  etagSeq = 0;

  s3mock.reset();

  s3mock.on(GetObjectCommand).callsFake((input) => {
    const rec = store.get(input.Key as string);
    if (!rec) {
      throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    }
    return {
      Body: { transformToString: async () => rec.body },
      ETag: `"${rec.etag}"`,
    };
  });

  s3mock.on(PutObjectCommand).callsFake((input) => {
    const key = input.Key as string;
    const existing = store.get(key);
    if (input.IfNoneMatch === '*' && existing) {
      throw Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed' });
    }
    if (input.IfMatch) {
      const want = String(input.IfMatch).replaceAll('"', '');
      if (!existing || existing.etag !== want) {
        throw Object.assign(new Error('PreconditionFailed'), {
          $metadata: { httpStatusCode: 412 },
        });
      }
    }
    const etag = `e${++etagSeq}`;
    store.set(key, { body: String(input.Body), etag });
    return { ETag: `"${etag}"` };
  });
}

function seedUser(userId: string, displayName: string) {
  const u: User = { userId, displayName, sessionVersion: 0, createdAt: '2026-01-01T00:00:00Z' };
  store.set(metaKeys.user(userId), { body: JSON.stringify(u), etag: `u-${userId}` });
}

beforeEach(setupMock);

describe('createGroup', () => {
  it('作成者が管理者兼メンバー、user-groups も作られる', async () => {
    const g = await createGroup(ctx, 'u1', ' 家族 ', '2026-01-01T00:00:00Z');
    expect(g.name).toBe('家族'); // トリムされる
    expect(g.adminUserIds).toEqual(['u1']);
    expect(g.memberUserIds).toEqual(['u1']);
    expect(store.has(metaKeys.group(g.groupId))).toBe(true);
    expect(store.has(metaKeys.userGroup('u1', g.groupId))).toBe(true);
  });

  it('空名・長すぎる名を拒否', async () => {
    await expect(createGroup(ctx, 'u1', '   ', 'now')).rejects.toBeInstanceOf(AppError);
    await expect(createGroup(ctx, 'u1', 'x'.repeat(51), 'now')).rejects.toBeInstanceOf(AppError);
  });
});

describe('getGroupDetail', () => {
  it('メンバーは表示名一覧を取得、非メンバーは404', async () => {
    seedUser('u1', 'アリス');
    const g = await createGroup(ctx, 'u1', 'fam', '2026-01-01T00:00:00Z');
    const detail = await getGroupDetail(ctx, g.groupId, 'u1');
    expect(detail.members).toEqual([{ userId: 'u1', displayName: 'アリス' }]);

    await expect(getGroupDetail(ctx, g.groupId, 'stranger')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 404,
    );
  });
});

describe('issueInvite / revokeInvite', () => {
  it('管理者は発行でき、トークンのハッシュがキーになる（平文は保存しない）', async () => {
    const g = await createGroup(ctx, 'admin', 'fam', '2026-01-01T00:00:00Z');
    const invite = await issueInvite(ctx, g.groupId, 'admin', Date.now());
    expect(invite.inviteId).toBe(sha256Hex(invite.token));
    expect(store.has(metaKeys.inviteByHash(invite.inviteId))).toBe(true);
    // 平文トークンはどのキーにも保存されない
    for (const [, v] of store) {
      expect(v.body).not.toContain(invite.token);
    }
  });

  it('非管理者の発行は403', async () => {
    const g = await createGroup(ctx, 'admin', 'fam', '2026-01-01T00:00:00Z');
    // member を手動で追加
    const key = metaKeys.group(g.groupId);
    const cur = JSON.parse(store.get(key)!.body);
    cur.memberUserIds.push('member');
    store.set(key, { body: JSON.stringify(cur), etag: 'e-mod' });

    await expect(issueInvite(ctx, g.groupId, 'member', Date.now())).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 403,
    );
  });

  it('失効は冪等、失効後は受け入れ不可', async () => {
    const g = await createGroup(ctx, 'admin', 'fam', '2026-01-01T00:00:00Z');
    const invite = await issueInvite(ctx, g.groupId, 'admin', Date.now());
    await revokeInvite(ctx, g.groupId, invite.inviteId, 'admin', '2026-01-02T00:00:00Z');
    await revokeInvite(ctx, g.groupId, invite.inviteId, 'admin', '2026-01-02T00:00:00Z'); // 冪等
    await expect(acceptInvite(ctx, invite.token, 'u2', Date.now())).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 410,
    );
  });
});

describe('acceptInvite', () => {
  it('有効な招待でメンバー追加、user-groups 修復、重複は冪等', async () => {
    const g = await createGroup(ctx, 'admin', 'fam', '2026-01-01T00:00:00Z');
    const invite = await issueInvite(ctx, g.groupId, 'admin', Date.now());

    const r1 = await acceptInvite(ctx, invite.token, 'u2', Date.now());
    expect(r1.groupId).toBe(g.groupId);
    const group1 = JSON.parse(store.get(metaKeys.group(g.groupId))!.body);
    expect(group1.memberUserIds).toContain('u2');
    expect(store.has(metaKeys.userGroup('u2', g.groupId))).toBe(true);

    // 二重受け入れ（冪等）: メンバーは重複しない
    await acceptInvite(ctx, invite.token, 'u2', Date.now());
    const group2 = JSON.parse(store.get(metaKeys.group(g.groupId))!.body);
    expect(group2.memberUserIds.filter((x: string) => x === 'u2')).toHaveLength(1);
  });

  it('不正トークンは404', async () => {
    await expect(acceptInvite(ctx, 'bogus', 'u2', Date.now())).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 404,
    );
  });

  it('期限切れは410', async () => {
    const g = await createGroup(ctx, 'admin', 'fam', '2026-01-01T00:00:00Z');
    const past = Date.now() - 1_000_000_000; // 十分過去に発行
    const invite = await issueInvite(ctx, g.groupId, 'admin', past);
    await expect(acceptInvite(ctx, invite.token, 'u2', Date.now())).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 410,
    );
  });
});
