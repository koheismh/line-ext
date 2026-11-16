// 招待の判定・使用済み化（claim）の共通ロジック（app層）。
// requirements 要件1-13（新規登録は招待必須）、2-12（1回限り）。
// app/auth.ts と app/groups.ts の双方から使う（循環importを避けるため独立させる）。

import type { Invite } from '@photo-album/shared';
import { getJson, putJsonIfMatch, metaKeys, ConflictError, sha256Hex } from '../repo/index.js';
import type { AppContext } from './context.js';
import { getGroup } from './entities.js';

/** 招待が使えない理由。ログイン画面の `login_error` にもそのまま使う。 */
export type InviteRejectReason =
  | 'invite_invalid'
  | 'invite_revoked'
  | 'invite_expired'
  | 'invite_used';

/** 使用済みだが利用者が作られなかった（孤児claim）場合に再claimを許すまでの猶予。 */
export const ORPHAN_CLAIM_GRACE_MS = 5 * 60 * 1000;

const MAX_CLAIM_RETRY = 3;

export type ClaimResult = { ok: true; invite: Invite } | { ok: false; reason: InviteRejectReason };

/** トークン形式の簡易検証。 */
export function isPlausibleToken(token: unknown): token is string {
  return typeof token === 'string' && token.length > 0 && token.length <= 200;
}

/**
 * 招待を userId で使用済みにする。
 * - 自分が既に使用済みなら冪等に成功
 * - 他人が使用済みなら invite_used
 *   （allowOrphanReclaim 指定時のみ、claim後に利用者が作られなかった孤児claimを猶予経過後に再claim可）
 * - 招待先のグループが削除済み・存在しないなら invite_revoked（使用済みにしない）
 * - 同時claimは ETag 競合で片方が負け、読み直して判定する
 */
export async function claimInvite(
  ctx: AppContext,
  token: unknown,
  userId: string,
  nowMs: number,
  opts: { allowOrphanReclaim?: boolean } = {},
): Promise<ClaimResult> {
  if (!isPlausibleToken(token)) return { ok: false, reason: 'invite_invalid' };
  const key = metaKeys.inviteByHash(sha256Hex(token));

  for (let attempt = 0; attempt < MAX_CLAIM_RETRY; attempt++) {
    const rec = await getJson<Invite>(ctx.metaBucket, key);
    if (!rec) return { ok: false, reason: 'invite_invalid' };
    const invite = rec.value;

    if (invite.usedBy === userId) return { ok: true, invite }; // 冪等
    if (invite.revokedAt) return { ok: false, reason: 'invite_revoked' };
    if (invite.usedBy) {
      if (!(opts.allowOrphanReclaim && (await isReclaimable(ctx, invite, nowMs)))) {
        return { ok: false, reason: 'invite_used' };
      }
    } else if (Date.parse(invite.expiresAt) <= nowMs) {
      return { ok: false, reason: 'invite_expired' };
    }
    // 削除されたグループへの招待では、新規登録も参加もさせない（失効と同じ扱い）
    if (!(await getGroup(ctx, invite.groupId))) {
      return { ok: false, reason: 'invite_revoked' };
    }

    const updated: Invite = { ...invite, usedBy: userId, usedAt: new Date(nowMs).toISOString() };
    try {
      await putJsonIfMatch(ctx.metaBucket, key, updated, rec.etag);
      return { ok: true, invite: updated };
    } catch (err) {
      if (err instanceof ConflictError) continue; // 読み直して判定
      throw err;
    }
  }
  return { ok: false, reason: 'invite_used' };
}

/** claim済みだが利用者が存在せず、猶予も過ぎている場合のみ再claimできる。 */
async function isReclaimable(ctx: AppContext, invite: Invite, nowMs: number): Promise<boolean> {
  if (!invite.usedBy || !invite.usedAt) return false;
  if (nowMs - Date.parse(invite.usedAt) < ORPHAN_CLAIM_GRACE_MS) return false;
  const user = await getJson(ctx.metaBucket, metaKeys.user(invite.usedBy));
  return user === null;
}
