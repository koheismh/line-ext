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

/** 認証済みセッションの情報。 */
export interface AuthenticatedSession {
  userId: string;
  user: User;
  /** リクエストで提示された署名付きセッショントークン（Cookie延長に使う）。 */
  token: string;
}

/**
 * 変更系リクエストの Origin を検証する（要件1-12）。不正なら 403。
 * 認証不要の変更系（ログアウト）からも使う。
 */
export function assertSameOrigin(req: RequestMeta, allowedOrigin: string): void {
  const origin = req.origin ?? originFromReferer(req.referer);
  if (!isAllowedByCsrf(req.method, origin, allowedOrigin)) {
    throw forbidden('不正なリクエスト元です。');
  }
}

/**
 * セッションを検証する。
 * - セッション無効/未ログインは 401
 * - 変更系で Origin 不正は 403（CSRF）
 */
export async function authenticate(
  ctx: AppContext,
  req: RequestMeta,
  cookieSecret: string,
  allowedOrigin: string,
): Promise<AuthenticatedSession> {
  // CSRF（変更系のみ）
  assertSameOrigin(req, allowedOrigin);

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
  return { userId: payload.userId, user: userRec.value, token };
}

/** 認証済み userId を解決する（authenticate の簡易版）。 */
export async function requireUser(
  ctx: AppContext,
  req: RequestMeta,
  cookieSecret: string,
  allowedOrigin: string,
): Promise<string> {
  const session = await authenticate(ctx, req, cookieSecret, allowedOrigin);
  return session.userId;
}
