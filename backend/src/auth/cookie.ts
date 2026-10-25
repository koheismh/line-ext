// セッションCookieの属性組み立てと解析。
// requirements/security: Secure / HttpOnly / SameSite=Lax。無期限運用のため Max-Age は付けない。

const SESSION_COOKIE_NAME = 'session';

export { SESSION_COOKIE_NAME };

/**
 * Set-Cookie ヘッダ値を組み立てる。
 * @param token 署名付きセッショントークン
 */
export function buildSessionCookie(token: string): string {
  // Path=/、Secure、HttpOnly、SameSite=Lax。Max-Age なし（無期限）。
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
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
