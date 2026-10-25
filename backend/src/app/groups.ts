// グループと招待のユースケース（app層）。
// requirements 要件2 に準拠。
//  - グループ作成: 作成者を管理者兼メンバーに。name 必須。
//  - 招待発行/失効: 管理者のみ。トークンはハッシュをキーに保存（平文は保存しない）。
//  - 招待受け入れ: 明示操作・冪等・期限/失効検証・user-groups 修復。

import {
  randomBytes,
} from 'node:crypto';
import {
  GROUP_NAME_MAX_LENGTH,
  INVITE_TTL_MS,
  randomId,
  type Group,
  type Invite,
  type User,
} from '@photo-album/shared';
import {
  getJson,
  getJsonOrThrow,
  putJsonIfMatch,
  putJsonIfAbsent,
  putJson,
  metaKeys,
  sha256Hex,
  ConflictError,
} from '../repo/index.js';
import { canManageInvite } from '../domain/authz.js';
import type { AppContext } from './context.js';
import { AppError, forbidden, notFoundOrForbidden } from './errors.js';
import { getGroup } from './entities.js';

const MAX_RETRY = 5;

/** グループを作成し、作成者を管理者兼メンバーにする。 */
export async function createGroup(
  ctx: AppContext,
  userId: string,
  name: string,
  now: string,
): Promise<Group> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > GROUP_NAME_MAX_LENGTH) {
    throw new AppError(422, 'invalid_group_name', `グループ名は1〜${GROUP_NAME_MAX_LENGTH}文字で入力してください。`);
  }
  const group: Group = {
    groupId: randomId(),
    name: trimmed,
    adminUserIds: [userId],
    memberUserIds: [userId],
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };
  await putJsonIfAbsent(ctx.metaBucket, metaKeys.group(group.groupId), group);
  // 検索用インデックス（正本ではない）
  await putJson(ctx.metaBucket, metaKeys.userGroup(userId, group.groupId), {
    groupId: group.groupId,
  });
  return group;
}

export interface GroupDetail {
  group: Group;
  members: { userId: string; displayName: string }[];
}

/** グループ詳細（メンバー表示名一覧を含む）。メンバーのみ閲覧可。 */
export async function getGroupDetail(
  ctx: AppContext,
  groupId: string,
  userId: string,
): Promise<GroupDetail> {
  const rec = await getGroup(ctx, groupId);
  if (!rec) throw notFoundOrForbidden();
  const group = rec.value;
  if (!group.memberUserIds.includes(userId)) {
    throw notFoundOrForbidden(); // 非メンバーには存在を隠す
  }
  const members = await Promise.all(
    group.memberUserIds.map(async (id) => {
      const u = await getJson<User>(ctx.metaBucket, metaKeys.user(id));
      return { userId: id, displayName: u?.value.displayName ?? '(不明)' };
    }),
  );
  return { group, members };
}

export interface IssuedInvite {
  inviteId: string; // = トークンのハッシュ。失効に使う
  token: string; // 平文（この応答でのみ返す。保存しない）
  expiresAt: string;
}

/** 招待を発行する（管理者のみ）。トークンはハッシュをキーに保存。 */
export async function issueInvite(
  ctx: AppContext,
  groupId: string,
  userId: string,
  nowMs: number,
): Promise<IssuedInvite> {
  const rec = await getGroup(ctx, groupId);
  if (!rec) throw notFoundOrForbidden();
  if (!rec.value.memberUserIds.includes(userId)) throw notFoundOrForbidden();
  if (!canManageInvite(rec.value, userId)) {
    throw forbidden('招待を発行できるのは管理者のみです。');
  }
  const token = randomBytes(32).toString('base64url');
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(nowMs + INVITE_TTL_MS).toISOString();
  const invite: Invite = {
    groupId,
    expiresAt,
    revokedAt: null,
    createdBy: userId,
    createdAt: new Date(nowMs).toISOString(),
  };
  await putJsonIfAbsent(ctx.metaBucket, metaKeys.inviteByHash(tokenHash), invite);
  return { inviteId: tokenHash, token, expiresAt };
}

/** 招待を失効する（管理者のみ）。inviteId はトークンのハッシュ。 */
export async function revokeInvite(
  ctx: AppContext,
  groupId: string,
  inviteId: string,
  userId: string,
  now: string,
): Promise<void> {
  const rec = await getGroup(ctx, groupId);
  if (!rec) throw notFoundOrForbidden();
  if (!canManageInvite(rec.value, userId)) {
    throw forbidden('招待を失効できるのは管理者のみです。');
  }
  const inviteRec = await getJson<Invite>(ctx.metaBucket, metaKeys.inviteByHash(inviteId));
  if (!inviteRec || inviteRec.value.groupId !== groupId) {
    throw notFoundOrForbidden('招待が見つかりません。');
  }
  if (inviteRec.value.revokedAt) return; // 既に失効（冪等）
  const updated: Invite = { ...inviteRec.value, revokedAt: now };
  await putJsonIfMatch(ctx.metaBucket, metaKeys.inviteByHash(inviteId), updated, inviteRec.etag);
}

/**
 * 招待を受け入れてメンバーに追加する（明示操作・冪等）。
 * - 期限切れ・失効・不正は拒否
 * - 既にメンバーなら冪等に成功
 * - メンバー追加は ETag 条件付きで競合時リトライ
 * - user-groups インデックスを修復（冪等）
 */
export async function acceptInvite(
  ctx: AppContext,
  token: string,
  userId: string,
  nowMs: number,
): Promise<{ groupId: string }> {
  const tokenHash = sha256Hex(token);
  const inviteRec = await getJson<Invite>(ctx.metaBucket, metaKeys.inviteByHash(tokenHash));
  if (!inviteRec) {
    throw new AppError(404, 'invite_invalid', '招待が無効です。');
  }
  const invite = inviteRec.value;
  if (invite.revokedAt) {
    throw new AppError(410, 'invite_revoked', 'この招待は失効しています。');
  }
  if (Date.parse(invite.expiresAt) <= nowMs) {
    throw new AppError(410, 'invite_expired', 'この招待は期限切れです。');
  }

  const groupId = invite.groupId;
  await addMemberWithRetry(ctx, groupId, userId);
  // 検索用インデックスの修復（冪等・無条件put）
  await putJson(ctx.metaBucket, metaKeys.userGroup(userId, groupId), { groupId });
  return { groupId };
}

/** メンバー追加をETag条件付きで行う。既にメンバーなら何もしない（冪等）。 */
async function addMemberWithRetry(
  ctx: AppContext,
  groupId: string,
  userId: string,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const rec = await getJsonOrThrow<Group>(ctx.metaBucket, metaKeys.group(groupId));
    if (rec.value.memberUserIds.includes(userId)) {
      return; // 既にメンバー（冪等）
    }
    const updated: Group = {
      ...rec.value,
      memberUserIds: [...rec.value.memberUserIds, userId],
      updatedAt: new Date().toISOString(),
    };
    try {
      await putJsonIfMatch(ctx.metaBucket, metaKeys.group(groupId), updated, rec.etag);
      return;
    } catch (err) {
      if (err instanceof ConflictError && attempt < MAX_RETRY - 1) {
        continue; // 競合したので読み直して再試行
      }
      throw err;
    }
  }
}
