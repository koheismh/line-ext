// グループと招待のユースケース（app層）。
// requirements 要件2 に準拠。
//  - グループ作成: 作成者を管理者兼メンバーに。name 必須。
//  - 所属グループ一覧: user-groups インデックス → 正本で照合。
//  - 招待発行/一覧/失効: 管理者のみ。トークンはハッシュをキーに保存（平文は保存しない）。
//  - 招待受け入れ: 明示操作・冪等・期限/失効検証・user-groups 修復。

import { randomBytes } from 'node:crypto';
import {
  GROUP_NAME_MAX_LENGTH,
  INVITE_TTL_MS,
  randomId,
  type Group,
  type GroupSummary,
  type Invite,
  type InviteSummary,
  type User,
} from '@photo-album/shared';
import {
  getJson,
  getJsonOrThrow,
  putJsonIfMatch,
  putJsonIfAbsent,
  putJson,
  listJson,
  metaKeys,
  sha256Hex,
  ConflictError,
} from '../repo/index.js';
import { canManageInvite, isGroupAdmin, isGroupMember } from '../domain/authz.js';
import { validateText } from '../domain/validation.js';
import type { AppContext } from './context.js';
import { AppError, forbidden, notFoundOrForbidden } from './errors.js';
import { getGroup } from './entities.js';

const MAX_RETRY = 5;

/** グループを作成し、作成者を管理者兼メンバーにする。 */
export async function createGroup(
  ctx: AppContext,
  userId: string,
  name: unknown,
  now: string,
): Promise<Group> {
  const v = validateText(typeof name === 'string' ? name.trim() : name, {
    label: 'グループ名',
    max: GROUP_NAME_MAX_LENGTH,
  });
  if (!v.ok) throw new AppError(422, 'invalid_group_name', v.message);
  const group: Group = {
    groupId: randomId(),
    name: v.value,
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

/**
 * ユーザーが現在メンバーであるグループの正本一覧。
 * user-groups は検索用インデックスなので、必ず groups/{groupId}.json で照合する（要件2-11）。
 */
export async function loadMemberGroups(ctx: AppContext, userId: string): Promise<Group[]> {
  const index = await listJson<{ groupId: string }>(
    ctx.metaBucket,
    metaKeys.userGroupsPrefix(userId),
  );
  const groups: Group[] = [];
  for (const { groupId } of index) {
    const rec = await getGroup(ctx, groupId);
    if (!rec || !isGroupMember(rec.value, userId)) continue; // インデックスの残骸は除外
    groups.push(rec.value);
  }
  return groups;
}

/** 所属グループ一覧（GET /api/groups）。 */
export async function listGroups(ctx: AppContext, userId: string): Promise<GroupSummary[]> {
  const groups = await loadMemberGroups(ctx, userId);
  return groups
    .map((g) => ({ groupId: g.groupId, name: g.name, isAdmin: isGroupAdmin(g, userId) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
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
  if (!isGroupMember(group, userId)) {
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

/** 招待管理（発行・一覧・失効）の権限を解決する。非メンバーは404、メンバーだが非管理者は403。 */
async function authorizeInviteManagement(
  ctx: AppContext,
  groupId: string,
  userId: string,
  message: string,
): Promise<Group> {
  const rec = await getGroup(ctx, groupId);
  if (!rec || !isGroupMember(rec.value, userId)) throw notFoundOrForbidden();
  if (!canManageInvite(rec.value, userId)) throw forbidden(message);
  return rec.value;
}

/** 招待を発行する（管理者のみ）。トークンはハッシュをキーに保存。 */
export async function issueInvite(
  ctx: AppContext,
  groupId: string,
  userId: string,
  nowMs: number,
): Promise<IssuedInvite> {
  await authorizeInviteManagement(ctx, groupId, userId, '招待を発行できるのは管理者のみです。');
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
  // 正本を先、検索用インデックス（グループ別の招待一覧）を後に書く
  await putJsonIfAbsent(ctx.metaBucket, metaKeys.inviteByHash(tokenHash), invite);
  await putJson(ctx.metaBucket, metaKeys.groupInvite(groupId, tokenHash), { inviteId: tokenHash });
  return { inviteId: tokenHash, token, expiresAt };
}

/**
 * 有効な（期限内・未失効の）招待一覧（管理者のみ）。
 * トークン平文は保存していないため返さない。流出時の失効操作に使う（要件2-8）。
 */
export async function listInvites(
  ctx: AppContext,
  groupId: string,
  userId: string,
  nowMs: number,
): Promise<InviteSummary[]> {
  await authorizeInviteManagement(ctx, groupId, userId, '招待を管理できるのは管理者のみです。');
  const index = await listJson<{ inviteId: string }>(
    ctx.metaBucket,
    metaKeys.groupInvitesPrefix(groupId),
  );
  const out: InviteSummary[] = [];
  for (const { inviteId } of index) {
    const rec = await getJson<Invite>(ctx.metaBucket, metaKeys.inviteByHash(inviteId));
    if (!rec) continue;
    const inv = rec.value;
    // 正本で照合（インデックスを信用しない）。失効済み・期限切れは除外
    if (inv.groupId !== groupId || inv.revokedAt || Date.parse(inv.expiresAt) <= nowMs) continue;
    out.push({ inviteId, expiresAt: inv.expiresAt, createdAt: inv.createdAt });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * 招待を失効する（管理者のみ）。inviteId はトークンのハッシュ。
 * 所属グループはクライアント申告ではなく招待の正本から解決する。
 */
export async function revokeInvite(
  ctx: AppContext,
  inviteId: string,
  userId: string,
  now: string,
): Promise<void> {
  const inviteRec = await getJson<Invite>(ctx.metaBucket, metaKeys.inviteByHash(inviteId));
  if (!inviteRec) throw notFoundOrForbidden('招待が見つかりません。');
  await authorizeInviteManagement(
    ctx,
    inviteRec.value.groupId,
    userId,
    '招待を失効できるのは管理者のみです。',
  );
  if (inviteRec.value.revokedAt) return; // 既に失効（冪等）
  const updated: Invite = { ...inviteRec.value, revokedAt: now };
  try {
    await putJsonIfMatch(ctx.metaBucket, metaKeys.inviteByHash(inviteId), updated, inviteRec.etag);
  } catch (err) {
    // 同時失効の競合は、読み直して失効済みなら成功扱い（冪等）
    if (err instanceof ConflictError) {
      const again = await getJson<Invite>(ctx.metaBucket, metaKeys.inviteByHash(inviteId));
      if (again?.value.revokedAt) return;
    }
    throw err;
  }
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
  token: unknown,
  userId: string,
  nowMs: number,
): Promise<{ groupId: string }> {
  if (typeof token !== 'string' || token.length === 0 || token.length > 200) {
    throw new AppError(404, 'invite_invalid', '招待が無効です。');
  }
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
