import { describe, it, expect, beforeEach } from 'vitest';
import { GetObjectCommand } from '@aws-sdk/client-s3';
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
  renameGroup,
  deleteGroup,
} from './groups.js';
import { AppError } from './errors.js';
import { metaKeys, sha256Hex } from '../repo/keys.js';
import type { Group, Invite, User } from '@photo-album/shared';

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
    expect(groups).toEqual([{ groupId: mine.groupId, name: 'うち', memberCount: 1, isAdmin: true }]);
  });

  it('メンバー数は正本の人数。管理者でないグループは isAdmin=false', async () => {
    const g = await createGroup(ctx, 'admin', 'みんな', 'now');
    addMember(g.groupId, 'u2');
    mem.put(metaKeys.userGroup('u2', g.groupId), { groupId: g.groupId });
    const groups = await listGroups(ctx, 'u2');
    expect(groups).toEqual([{ groupId: g.groupId, name: 'みんな', memberCount: 2, isAdmin: false }]);
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

/** AppError のステータス（と任意でコード）を確かめる。 */
function isAppError(status: number, code?: string) {
  return (e: unknown) => e instanceof AppError && e.status === status && (!code || e.code === code);
}

/**
 * key を最初に読んだ直後に、別の処理が正本を更新した状況を再現する（ETag 競合の再試行の確認用）。
 * 読み込み自体は memoryS3 と同じ内容を返す。
 */
function interfereAfterFirstRead(key: string, interfere: () => void) {
  let done = false;
  mem.mock.on(GetObjectCommand).callsFake((input) => {
    const rec = store.get(input.Key as string);
    if (!rec) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    const res = { Body: { transformToString: async () => rec.body }, ETag: `"${rec.etag}"` };
    if (input.Key === key && !done) {
      done = true;
      interfere();
    }
    return res;
  });
}

describe('renameGroup（要件2-14）', () => {
  it('管理者は名前を変更でき（前後の空白は除く）、一覧と詳細に反映される', async () => {
    const g = await createGroup(ctx, 'admin', 'うち', '2026-01-01T00:00:00Z');
    const renamed = await renameGroup(ctx, g.groupId, 'admin', ' 山田家 ', '2026-01-02T00:00:00Z');
    expect(renamed.name).toBe('山田家');
    expect(renamed.updatedAt).toBe('2026-01-02T00:00:00Z');
    expect((mem.get(metaKeys.group(g.groupId)) as Group).name).toBe('山田家');
    expect((await listGroups(ctx, 'admin')).map((x) => x.name)).toEqual(['山田家']);
  });

  it('同じ名前の二重送信は書き込まずに成功する', async () => {
    const g = await createGroup(ctx, 'admin', 'うち', '2026-01-01T00:00:00Z');
    await renameGroup(ctx, g.groupId, 'admin', '山田家', '2026-01-02T00:00:00Z');
    const again = await renameGroup(ctx, g.groupId, 'admin', '山田家', '2026-01-03T00:00:00Z');
    expect(again.updatedAt).toBe('2026-01-02T00:00:00Z'); // 2回目は変更なし
  });

  it('管理者でないメンバーは403、非メンバーは404、不正な名前は422（いずれも変わらない）', async () => {
    const g = await createGroup(ctx, 'admin', 'うち', 'now');
    addMember(g.groupId, 'member');
    await expect(renameGroup(ctx, g.groupId, 'member', 'x', 'now')).rejects.toSatisfy(isAppError(403));
    await expect(renameGroup(ctx, g.groupId, 'stranger', 'x', 'now')).rejects.toSatisfy(isAppError(404));
    await expect(renameGroup(ctx, 'no-such-group', 'admin', 'x', 'now')).rejects.toSatisfy(isAppError(404));
    for (const bad of ['   ', 'x'.repeat(51), undefined, 123]) {
      await expect(renameGroup(ctx, g.groupId, 'admin', bad, 'now')).rejects.toSatisfy(
        isAppError(422, 'invalid_group_name'),
      );
    }
    expect((mem.get(metaKeys.group(g.groupId)) as Group).name).toBe('うち');
  });

  it('同時に誰かが参加しても、読み直して変更し、参加した人を消さない', async () => {
    const g = await createGroup(ctx, 'admin', 'うち', 'now');
    interfereAfterFirstRead(metaKeys.group(g.groupId), () => addMember(g.groupId, 'u2'));
    await renameGroup(ctx, g.groupId, 'admin', '山田家', 'now');
    const stored = mem.get(metaKeys.group(g.groupId)) as Group;
    expect(stored.name).toBe('山田家');
    expect(stored.memberUserIds).toEqual(['admin', 'u2']);
  });
});

describe('deleteGroup（要件2-15）', () => {
  it('アルバムのないグループを管理者が削除すると、記録を残したまま全員から見えなくなる', async () => {
    const g = await createGroup(ctx, 'admin', 'うち', '2026-01-01T00:00:00Z');
    addMember(g.groupId, 'u2');
    mem.put(metaKeys.userGroup('u2', g.groupId), { groupId: g.groupId });

    await deleteGroup(ctx, g.groupId, 'admin', '2026-01-02T00:00:00Z');

    const stored = mem.get(metaKeys.group(g.groupId)) as Group;
    expect(stored.deletedAt).toBe('2026-01-02T00:00:00Z');
    expect(stored.deletedBy).toBe('admin');
    expect(stored.memberUserIds).toEqual(['admin', 'u2']); // 復元できるよう消さない
    expect(await listGroups(ctx, 'admin')).toEqual([]);
    expect(await listGroups(ctx, 'u2')).toEqual([]);
    await expect(getGroupDetail(ctx, g.groupId, 'u2')).rejects.toSatisfy(isAppError(404));
    await expect(issueInvite(ctx, g.groupId, 'admin', Date.now())).rejects.toSatisfy(isAppError(404));
    await expect(renameGroup(ctx, g.groupId, 'admin', 'x', 'now')).rejects.toSatisfy(isAppError(404));
  });

  it('アルバムが1つでもあるグループは409で削除しない', async () => {
    const g = await createGroup(ctx, 'admin', 'うち', 'now');
    mem.put(metaKeys.album('group', g.groupId, 'a1'), { albumId: 'a1' });
    await expect(deleteGroup(ctx, g.groupId, 'admin', 'now')).rejects.toSatisfy(
      isAppError(409, 'group_not_empty'),
    );
    expect((mem.get(metaKeys.group(g.groupId)) as Group).deletedAt).toBeUndefined();
    expect(await listGroups(ctx, 'admin')).toHaveLength(1);
  });

  it('二重実行は冪等に成功する。管理者でないメンバーは403、非メンバーと削除後の他人は404', async () => {
    const g = await createGroup(ctx, 'admin', 'うち', 'now');
    addMember(g.groupId, 'member');
    await expect(deleteGroup(ctx, g.groupId, 'member', 'now')).rejects.toSatisfy(isAppError(403));
    await expect(deleteGroup(ctx, g.groupId, 'stranger', 'now')).rejects.toSatisfy(isAppError(404));
    await expect(deleteGroup(ctx, 'no-such-group', 'admin', 'now')).rejects.toSatisfy(isAppError(404));

    await deleteGroup(ctx, g.groupId, 'admin', '2026-01-02T00:00:00Z');
    await deleteGroup(ctx, g.groupId, 'admin', '2026-01-03T00:00:00Z'); // 二重クリック
    expect((mem.get(metaKeys.group(g.groupId)) as Group).deletedAt).toBe('2026-01-02T00:00:00Z');
    await expect(deleteGroup(ctx, g.groupId, 'member', 'now')).rejects.toSatisfy(isAppError(404));
  });

  it('同時に誰かが参加しても、読み直して削除する', async () => {
    const g = await createGroup(ctx, 'admin', 'うち', 'now');
    interfereAfterFirstRead(metaKeys.group(g.groupId), () => addMember(g.groupId, 'u2'));
    await deleteGroup(ctx, g.groupId, 'admin', '2026-01-02T00:00:00Z');
    const stored = mem.get(metaKeys.group(g.groupId)) as Group;
    expect(stored.deletedAt).toBe('2026-01-02T00:00:00Z');
    expect(stored.memberUserIds).toEqual(['admin', 'u2']);
  });

  it('削除したグループの招待では参加できず、招待も使用済みにならない（410 invite_revoked）', async () => {
    const g = await createGroup(ctx, 'admin', 'うち', 'now');
    const invite = await issueInvite(ctx, g.groupId, 'admin', Date.now());
    await deleteGroup(ctx, g.groupId, 'admin', 'now');

    await expect(acceptInvite(ctx, invite.token, 'u2', Date.now())).rejects.toSatisfy(
      isAppError(410, 'invite_revoked'),
    );
    expect((mem.get(metaKeys.inviteByHash(invite.inviteId)) as Invite).usedBy).toBeUndefined();
    expect((mem.get(metaKeys.group(g.groupId)) as Group).memberUserIds).not.toContain('u2');
  });

  it('参加済みの人が招待を再実行しても、削除したグループには戻らない（410）', async () => {
    const g = await createGroup(ctx, 'admin', 'うち', 'now');
    const invite = await issueInvite(ctx, g.groupId, 'admin', Date.now());
    await acceptInvite(ctx, invite.token, 'u2', Date.now());
    await deleteGroup(ctx, g.groupId, 'admin', 'now');

    await expect(acceptInvite(ctx, invite.token, 'u2', Date.now())).rejects.toSatisfy(
      isAppError(410, 'invite_revoked'),
    );
    expect(await listGroups(ctx, 'u2')).toEqual([]);
  });
});

describe('招待の1回限り化（要件2-12, 2-13）', () => {
  it('別のユーザーが使用済みの招待を使うと410 invite_used、メンバーにならない', async () => {
    const g = await createGroup(ctx, 'admin', 'fam', '2026-01-01T00:00:00Z');
    const invite = await issueInvite(ctx, g.groupId, 'admin', Date.now());
    await acceptInvite(ctx, invite.token, 'u2', Date.now());

    await expect(acceptInvite(ctx, invite.token, 'u3', Date.now())).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 410 && e.code === 'invite_used',
    );
    const group = mem.get(metaKeys.group(g.groupId)) as Group;
    expect(group.memberUserIds).not.toContain('u3');
  });

  it('使用済みの招待は一覧から除外される', async () => {
    const g = await createGroup(ctx, 'admin', 'fam', '2026-01-01T00:00:00Z');
    const used = await issueInvite(ctx, g.groupId, 'admin', Date.now());
    const unused = await issueInvite(ctx, g.groupId, 'admin', Date.now());
    await acceptInvite(ctx, used.token, 'u2', Date.now());

    const listed = await listInvites(ctx, g.groupId, 'admin', Date.now());
    expect(listed.map((i) => i.inviteId)).toEqual([unused.inviteId]);
  });

  it('本人の再実行は冪等で成功し、使用者は変わらない', async () => {
    const g = await createGroup(ctx, 'admin', 'fam', '2026-01-01T00:00:00Z');
    const invite = await issueInvite(ctx, g.groupId, 'admin', Date.now());
    await acceptInvite(ctx, invite.token, 'u2', Date.now());
    await expect(acceptInvite(ctx, invite.token, 'u2', Date.now())).resolves.toEqual({
      groupId: g.groupId,
    });
    const inv = mem.get(metaKeys.inviteByHash(invite.inviteId)) as { usedBy: string };
    expect(inv.usedBy).toBe('u2');
  });
});
