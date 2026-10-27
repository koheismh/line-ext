import { describe, it, expect, beforeEach } from 'vitest';
import { s3 } from '../repo/s3Client.js';
import { installMemoryS3, type MemoryS3 } from '../testing/memoryS3.js';
import {
  createGroup,
  getGroupDetail,
  issueInvite,
  listInvites,
  revokeInvite,
  acceptInvite,
  listGroups,
} from './groups.js';
import { AppError } from './errors.js';
import { metaKeys, sha256Hex } from '../repo/keys.js';
import type { Group, User } from '@photo-album/shared';

const ctx = { metaBucket: 'meta', mediaBucket: 'media' };
let mem: MemoryS3;
let store: MemoryS3['store'];

function seedUser(userId: string, displayName: string) {
  const u: User = { userId, displayName, sessionVersion: 0, createdAt: '2026-01-01T00:00:00Z' };
  mem.put(metaKeys.user(userId), u);
}

/** グループ正本にメンバーを直接追加する（テスト用）。 */
function addMember(groupId: string, userId: string) {
  const g = mem.get(metaKeys.group(groupId)) as Group;
  g.memberUserIds.push(userId);
  mem.put(metaKeys.group(groupId), g);
}

beforeEach(() => {
  mem = installMemoryS3(s3);
  store = mem.store;
});

describe('createGroup', () => {
  it('作成者が管理者兼メンバー、user-groups も作られる', async () => {
    const g = await createGroup(ctx, 'u1', ' 家族 ', '2026-01-01T00:00:00Z');
    expect(g.name).toBe('家族'); // トリムされる
    expect(g.adminUserIds).toEqual(['u1']);
    expect(g.memberUserIds).toEqual(['u1']);
    expect(store.has(metaKeys.group(g.groupId))).toBe(true);
    expect(store.has(metaKeys.userGroup('u1', g.groupId))).toBe(true);
  });

  it('空名・長すぎる名・文字列以外を拒否', async () => {
    await expect(createGroup(ctx, 'u1', '   ', 'now')).rejects.toBeInstanceOf(AppError);
    await expect(createGroup(ctx, 'u1', 'x'.repeat(51), 'now')).rejects.toBeInstanceOf(AppError);
    await expect(createGroup(ctx, 'u1', undefined, 'now')).rejects.toBeInstanceOf(AppError);
  });
});

describe('listGroups', () => {
  it('所属グループを返し、インデックスの残骸は正本照合で除外する', async () => {
    const mine = await createGroup(ctx, 'u1', 'うち', 'now');
    const other = await createGroup(ctx, 'u2', 'よそ', 'now');
    mem.put(metaKeys.userGroup('u1', other.groupId), { groupId: other.groupId }); // 残骸
    const groups = await listGroups(ctx, 'u1');
    expect(groups).toEqual([{ groupId: mine.groupId, name: 'うち', isAdmin: true }]);
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

describe('issueInvite / listInvites / revokeInvite', () => {
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

  it('非管理者の発行・一覧は403、非メンバーは404', async () => {
    const g = await createGroup(ctx, 'admin', 'fam', '2026-01-01T00:00:00Z');
    addMember(g.groupId, 'member');
    await expect(issueInvite(ctx, g.groupId, 'member', Date.now())).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 403,
    );
    await expect(listInvites(ctx, g.groupId, 'member', Date.now())).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 403,
    );
    await expect(issueInvite(ctx, g.groupId, 'stranger', Date.now())).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 404,
    );
  });

  it('有効な招待だけが一覧に出て、失効すると一覧から消え受け入れ不可になる（冪等）', async () => {
    const g = await createGroup(ctx, 'admin', 'fam', '2026-01-01T00:00:00Z');
    const invite = await issueInvite(ctx, g.groupId, 'admin', Date.now());
    const expired = await issueInvite(ctx, g.groupId, 'admin', Date.now() - 8 * 24 * 60 * 60 * 1000);
    const listed = await listInvites(ctx, g.groupId, 'admin', Date.now());
    expect(listed.map((i) => i.inviteId)).toEqual([invite.inviteId]);
    expect(listed.map((i) => i.inviteId)).not.toContain(expired.inviteId);
    expect(JSON.stringify(listed)).not.toContain(invite.token); // 平文は返さない

    await revokeInvite(ctx, invite.inviteId, 'admin', '2026-01-02T00:00:00Z');
    await revokeInvite(ctx, invite.inviteId, 'admin', '2026-01-02T00:00:00Z'); // 冪等
    expect(await listInvites(ctx, g.groupId, 'admin', Date.now())).toEqual([]);
    await expect(acceptInvite(ctx, invite.token, 'u2', Date.now())).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 410,
    );
  });

  it('失効は招待の正本からグループを解決する。非メンバーは404、非管理者は403', async () => {
    const g = await createGroup(ctx, 'admin', 'fam', '2026-01-01T00:00:00Z');
    addMember(g.groupId, 'member');
    const invite = await issueInvite(ctx, g.groupId, 'admin', Date.now());
    await expect(revokeInvite(ctx, invite.inviteId, 'stranger', 'now')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 404,
    );
    await expect(revokeInvite(ctx, invite.inviteId, 'member', 'now')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 403,
    );
    await expect(revokeInvite(ctx, 'no-such-invite', 'admin', 'now')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 404,
    );
  });
});

describe('acceptInvite', () => {
  it('有効な招待でメンバー追加、user-groups 修復、重複は冪等', async () => {
    const g = await createGroup(ctx, 'admin', 'fam', '2026-01-01T00:00:00Z');
    const invite = await issueInvite(ctx, g.groupId, 'admin', Date.now());

    const r1 = await acceptInvite(ctx, invite.token, 'u2', Date.now());
    expect(r1.groupId).toBe(g.groupId);
    const group1 = mem.get(metaKeys.group(g.groupId)) as Group;
    expect(group1.memberUserIds).toContain('u2');
    expect(store.has(metaKeys.userGroup('u2', g.groupId))).toBe(true);

    // 二重受け入れ（冪等）: メンバーは重複しない
    await acceptInvite(ctx, invite.token, 'u2', Date.now());
    const group2 = mem.get(metaKeys.group(g.groupId)) as Group;
    expect(group2.memberUserIds.filter((x: string) => x === 'u2')).toHaveLength(1);
  });

  it('不正トークンは404', async () => {
    await expect(acceptInvite(ctx, 'bogus', 'u2', Date.now())).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 404,
    );
    await expect(acceptInvite(ctx, undefined, 'u2', Date.now())).rejects.toSatisfy(
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
