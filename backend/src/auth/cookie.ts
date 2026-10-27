// セッションCookieの属性組み立てと解析。
// requirements/security: Secure / HttpOnly / SameSite=Lax。
// 要件1-6「無期限」: Max-Age を付けないセッションCookieはブラウザ終了で消えてしまうため、
// ブラウザ上限の長期 Max-Age（400日）を付け、/api/me のたびに延長する（実質無期限）。
// 失効はログアウト時の sessionVersion 更新で行う。

import { SESSION_COOKIE_MAX_AGE_SECONDS } from '@photo-album/shared';

const SESSION_COOKIE_NAME = 'session';

export { SESSION_COOKIE_NAME };

/**
 * Set-Cookie ヘッダ値を組み立てる。
 * @param token 署名付きセッショントークン
 */
export function buildSessionCookie(token: string): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
  ].join('; ');
}

/** ログアウト用に即時失効させる Set-Cookie。 */
export function buildClearSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

/** Cookie ヘッダからセッショントークンを取り出す。無ければ null。 */
export function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === SESSION_COOKIE_NAME) {
      return rest.join('=') || null;
    }
  }
  return null;
}
