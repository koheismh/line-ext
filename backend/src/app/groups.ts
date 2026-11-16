// グループと招待のユースケース（app層）。
// requirements 要件2 に準拠。
//  - グループ作成: 作成者を管理者兼メンバーに。name 必須。
//  - グループ名の変更・グループの削除: 管理者のみ。削除はアルバムが無いグループに限り、
//    記録を消さずに削除済み（deletedAt）にする。削除済みは存在しないものとして扱う。
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
  listKeys,
  metaKeys,
  sha256Hex,
  ConflictError,
} from '../repo/index.js';
import { canManageGroup, canManageInvite, isGroupAdmin, isGroupMember } from '../domain/authz.js';
import { validateText } from '../domain/validation.js';
import type { AppContext } from './context.js';
import { claimInvite, isPlausibleToken, type InviteRejectReason } from './invites.js';
import { AppError, forbidden, notFoundOrForbidden } from './errors.js';
import { getGroup, getGroupIncludingDeleted } from './entities.js';

const MAX_RETRY = 5;

/** グループ名を検証する（前後の空白は除く。必須・暫定50文字以内）。作成と名前の変更で共通。 */
function validateGroupName(name: unknown): string {
  const v = validateText(typeof name === 'string' ? name.trim() : name, {
    label: 'グループ名',
    max: GROUP_NAME_MAX_LENGTH,
  });
  if (!v.ok) throw new AppError(422, 'invalid_group_name', v.message);
  return v.value;
}

/** グループを作成し、作成者を管理者兼メンバーにする。 */
export async function createGroup(
  ctx: AppContext,
  userId: string,
  name: unknown,
  now: string,
): Promise<Group> {
  const group: Group = {
    groupId: randomId(),
    name: validateGroupName(name),
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
    .map((g) => ({
      groupId: g.groupId,
      name: g.name,
      memberCount: g.memberUserIds.length,
      isAdmin: isGroupAdmin(g, userId),
    }))
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

/**
 * グループ名を変更する（管理者のみ）。非メンバー・削除済みは404、管理者でないメンバーは403。
 * グループ名はアルバムなどに複製していないため、変更はすべての画面にそのまま反映される。
 * 参加などのシステム更新と競合した場合は、読み直して（権限も確認し直して）再試行する。
 */
export async function renameGroup(
  ctx: AppContext,
  groupId: string,
  userId: string,
  name: unknown,
  now: string,
): Promise<Group> {
  const newName = validateGroupName(name);
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const rec = await getGroup(ctx, groupId);
    if (!rec || !isGroupMember(rec.value, userId)) throw notFoundOrForbidden();
    if (!canManageGroup(rec.value, userId)) {
      throw forbidden('グループ名を変更できるのは管理者のみです。');
    }
    if (rec.value.name === newName) return rec.value; // 変更なし（二重送信も冪等）
    const updated: Group = { ...rec.value, name: newName, updatedAt: now };
    try {
      await putJsonIfMatch(ctx.metaBucket, metaKeys.group(groupId), updated, rec.etag);
      return updated;
    } catch (err) {
      if (err instanceof ConflictError && attempt < MAX_RETRY - 1) continue;
      throw err;
    }
  }
  throw new ConflictError();
}

/**
 * グループを削除する（管理者のみ）。要件2-15。
 * - アルバムが1件でもあるグループは削除しない（409 group_not_empty）。アルバム削除は MVP の対象外のため
 * - 記録は消さず deletedAt / deletedBy を付ける（メタデータはバージョニングしておらず、消すと戻せないため）。
 *   削除済みのグループは getGroup / isGroupMember で存在しないものとして扱われ、招待も使えなくなる
 * - 二重実行は冪等: 削除済みでも、削除前の管理者には成功を返す。それ以外には存在を隠す（404）
 * - user-groups の検索用インデックスは残す（正本照合で除外されるため害がない）
 */
export async function deleteGroup(
  ctx: AppContext,
  groupId: string,
  userId: string,
  now: string,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const rec = await getGroupIncludingDeleted(ctx, groupId);
    if (!rec) throw notFoundOrForbidden();
    const group = rec.value;
    if (group.deletedAt) {
      if (group.adminUserIds.includes(userId)) return;
      throw notFoundOrForbidden();
    }
    if (!isGroupMember(group, userId)) throw notFoundOrForbidden();
    if (!canManageGroup(group, userId)) {
      throw forbidden('グループを削除できるのは管理者のみです。');
    }
    if (await hasAlbums(ctx, groupId)) {
      throw new AppError(
        409,
        'group_not_empty',
        'アルバムがあるグループは削除できません。グループを削除できるのは、アルバムが1つもないときだけです。',
      );
    }
    const updated: Group = { ...group, deletedAt: now, deletedBy: userId, updatedAt: now };
    try {
      await putJsonIfMatch(ctx.metaBucket, metaKeys.group(groupId), updated, rec.etag);
      return;
    } catch (err) {
      if (err instanceof ConflictError && attempt < MAX_RETRY - 1) continue;
      throw err;
    }
  }
  throw new ConflictError();
}

/** グループにアルバムが1件でもあるか（キーの有無だけを見る）。 */
async function hasAlbums(ctx: AppContext, groupId: string): Promise<boolean> {
  const page = await listKeys(ctx.metaBucket, metaKeys.albumsPrefix('group', groupId), {
    maxKeys: 1,
  });
  return page.keys.length > 0;
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
    // 正本で照合（インデックスを信用しない）。失効済み・使用済み・期限切れは除外
    if (
      inv.groupId !== groupId ||
      inv.revokedAt ||
      inv.usedBy ||
      Date.parse(inv.expiresAt) <= nowMs
    )
      continue;
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
  if (!isPlausibleToken(token)) {
    throw new AppError(404, 'invite_invalid', '招待が無効です。');
  }
  // 1回限り: claim 済みの本人なら冪等に成功、他人なら invite_used
  const claim = await claimInvite(ctx, token, userId, nowMs);
  if (!claim.ok) {
    throw inviteRejection(claim.reason);
  }
  const invite = claim.invite;
  const groupId = invite.groupId;
  await addMemberWithRetry(ctx, groupId, userId);
  // 検索用インデックスの修復（冪等・無条件put）
  await putJson(ctx.metaBucket, metaKeys.userGroup(userId, groupId), { groupId });
  return { groupId };
}

/**
 * メンバー追加をETag条件付きで行う。既にメンバーなら何もしない（冪等）。
 * 招待の確認後にグループが削除された場合は、削除済みのグループに人を加えない（410）。
 */
async function addMemberWithRetry(ctx: AppContext, groupId: string, userId: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const rec = await getJsonOrThrow<Group>(ctx.metaBucket, metaKeys.group(groupId));
    if (rec.value.deletedAt) throw inviteRejection('invite_revoked');
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

/** 招待拒否理由を AppError に変換する。 */
function inviteRejection(reason: InviteRejectReason): AppError {
  switch (reason) {
    case 'invite_invalid':
      return new AppError(404, 'invite_invalid', '招待が無効です。');
    case 'invite_revoked':
      return new AppError(410, 'invite_revoked', 'この招待は失効しています。');
    case 'invite_expired':
      return new AppError(410, 'invite_expired', 'この招待は期限切れです。');
    case 'invite_used':
      return new AppError(410, 'invite_used', 'この招待はすでに使用されています。');
  }
}
