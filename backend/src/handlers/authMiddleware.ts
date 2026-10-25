// 認証ミドルウェア（handler層）。
// セッションCookie検証 → sessionVersion 照合 → userId 確定。
// 変更系は Origin/CSRF を検証する。

import type { User } from '@photo-album/shared';
import {
  readSessionCookie,
  verifySession,
  isSessionActive,
  isAllowedByCsrf,
  originFromReferer,
} from '../auth/index.js';
import { getJson, metaKeys } from '../repo/index.js';
import type { AppContext } from '../app/context.js';
import { unauthorized, forbidden } from '../app/errors.js';

export interface RequestMeta {
  method: string;
  cookieHeader?: string;
  origin?: string;
  referer?: string;
}

/**
 * 認証済み userId を解決する。
 * - セッション無効/未ログインは 401
 * - 変更系で Origin 不正は 403（CSRF）
 */
export async function requireUser(
  ctx: AppContext,
  req: RequestMeta,
  cookieSecret: string,
  allowedOrigin: string,
): Promise<string> {
  // CSRF（変更系のみ）
  const origin = req.origin ?? originFromReferer(req.referer);
  if (!isAllowedByCsrf(req.method, origin, allowedOrigin)) {
    throw forbidden('不正なリクエスト元です。');
  }

  const token = readSessionCookie(req.cookieHeader);
  if (!token) throw unauthorized();

  const payload = verifySession(token, cookieSecret);
  if (!payload) throw unauthorized();

  // sessionVersion を正本と照合（ログアウト後の旧Cookieを無効化）
  const userRec = await getJson<User>(ctx.metaBucket, metaKeys.user(payload.userId));
  if (!userRec) throw unauthorized();
  if (!isSessionActive(payload, userRec.value.sessionVersion)) {
    throw unauthorized('セッションが無効です。再度ログインしてください。');
  }
  return payload.userId;
}
