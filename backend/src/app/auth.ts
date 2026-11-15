// 認証ユースケース（app層）。requirements 要件1 に準拠。
//  - exchangeLineCode: 認可コードをIDトークンに交換（LINEのtokenエンドポイント）
//  - loginOrRegisterFromLine: 既存は表示名更新、新規は有効な招待を claim して作成（要件1-13）
//  - bumpSessionVersion: ログアウトで版数を上げ全Cookieを無効化

import { randomId, type User } from '@photo-album/shared';
import {
  getJson,
  putJsonIfMatch,
  putJsonIfAbsent,
  metaKeys,
  AlreadyExistsError,
} from '../repo/index.js';
import type { AppContext } from './context.js';
import { claimInvite, type InviteRejectReason } from './invites.js';

const LINE_TOKEN_URL = 'https://api.line.me/oauth2/v2.1/token';

/** identities/line/{hash} に保存する内部ID対応。 */
interface LineIdentity {
  userId: string;
  createdAt: string;
}

/**
 * 認可コードをトークンに交換し、id_token を得る。
 */
export async function exchangeLineCode(params: {
  code: string;
  redirectUri: string;
  channelId: string;
  channelSecret: string;
  codeVerifier: string;
}): Promise<{ idToken: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.channelId,
    client_secret: params.channelSecret,
    code_verifier: params.codeVerifier,
  });
  const res = await fetch(LINE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`LINEトークン交換に失敗しました (${res.status})`);
  }
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error('id_token を取得できませんでした。');
  return { idToken: json.id_token };
}

/** ログイン/登録の結果。拒否時は理由（画面の login_error）を返す。 */
export type LoginResult =
  | { ok: true; userId: string }
  | { ok: false; reason: 'invite_required' | InviteRejectReason };

/**
 * LINEの sub から内部ユーザーを解決する。要件1-13。
 * - 既存identity: 招待なしでログイン可。表示名を更新。
 * - 新規: 有効な招待が必須。招待を claim してから identity → user を作成する。
 *   招待が使えない場合は user/identity を一切作らない。
 */
export async function loginOrRegisterFromLine(
  ctx: AppContext,
  lineSub: string,
  displayName: string,
  now: string,
  inviteToken?: string | null,
): Promise<LoginResult> {
  const identityKey = metaKeys.lineIdentity(lineSub);
  const existing = await getJson<LineIdentity>(ctx.metaBucket, identityKey);

  if (existing) {
    const userId = existing.value.userId;
    await updateDisplayName(ctx, userId, displayName, now);
    return { ok: true, userId };
  }

  // 新規登録: 招待が必須
  if (!inviteToken) return { ok: false, reason: 'invite_required' };

  const userId = randomId();
  const claim = await claimInvite(ctx, inviteToken, userId, Date.parse(now), {
    allowOrphanReclaim: true,
  });
  if (!claim.ok) return { ok: false, reason: claim.reason };

  try {
    await putJsonIfAbsent<LineIdentity>(ctx.metaBucket, identityKey, { userId, createdAt: now });
  } catch (err) {
    if (err instanceof AlreadyExistsError) {
      // 同時初回ログインの競合: 先に作られた identity を採用する
      const again = await getJson<LineIdentity>(ctx.metaBucket, identityKey);
      if (again) {
        await updateDisplayName(ctx, again.value.userId, displayName, now);
        return { ok: true, userId: again.value.userId };
      }
    }
    throw err;
  }

  const user: User = { userId, displayName, sessionVersion: 0, createdAt: now };
  try {
    await putJsonIfAbsent<User>(ctx.metaBucket, metaKeys.user(userId), user);
  } catch (err) {
    if (!(err instanceof AlreadyExistsError)) throw err;
  }
  return { ok: true, userId };
}
/** 表示名を更新する（ETag条件付き・競合は軽リトライ）。 */
async function updateDisplayName(
  ctx: AppContext,
  userId: string,
  displayName: string,
  now: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const rec = await getJson<User>(ctx.metaBucket, metaKeys.user(userId));
    if (!rec) return;
    if (rec.value.displayName === displayName) return; // 変化なし
    try {
      await putJsonIfMatch<User>(
        ctx.metaBucket,
        metaKeys.user(userId),
        { ...rec.value, displayName },
        rec.etag,
      );
      void now;
      return;
    } catch {
      // 競合は読み直して再試行
    }
  }
}

/** 現在の sessionVersion を取得する（Cookie発行時に使う）。 */
export async function getSessionVersion(ctx: AppContext, userId: string): Promise<number> {
  const rec = await getJson<User>(ctx.metaBucket, metaKeys.user(userId));
  return rec?.value.sessionVersion ?? 0;
}

/** ログアウト: sessionVersion を +1 して以前のCookieを無効化する。 */
export async function bumpSessionVersion(ctx: AppContext, userId: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const rec = await getJson<User>(ctx.metaBucket, metaKeys.user(userId));
    if (!rec) return;
    try {
      await putJsonIfMatch<User>(
        ctx.metaBucket,
        metaKeys.user(userId),
        { ...rec.value, sessionVersion: rec.value.sessionVersion + 1 },
        rec.etag,
      );
      return;
    } catch {
      // 競合は再試行
    }
  }
}
