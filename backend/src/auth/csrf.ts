// CSRF対策（純粋関数）。
// requirements 要件1-12: 変更系API(POST/PATCH/DELETE)は Origin を検証する。
// 同一オリジン運用のため、Origin/Referer が自サイトのオリジンに一致することを確認する。

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** そのHTTPメソッドがCSRF検証対象（変更系）か。 */
export function isMutating(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/**
 * 変更系リクエストのOriginを検証する。
 * @param method HTTPメソッド
 * @param origin リクエストの Origin ヘッダ（無い場合は Referer のオリジン）
 * @param allowedOrigin 自サイトのオリジン（例: https://xxxx.cloudfront.net）
 * @returns 許可なら true。GET等の非変更系は常に true。
 */
export function isAllowedByCsrf(
  method: string,
  origin: string | null | undefined,
  allowedOrigin: string,
): boolean {
  if (!isMutating(method)) return true;
  if (!origin) return false; // 変更系で Origin 不在は拒否
  return origin === allowedOrigin;
}

/** Referer ヘッダからオリジンを抽出する（Origin が無い場合の補完用）。 */
export function originFromReferer(referer: string | null | undefined): string | null {
  if (!referer) return null;
  try {
    const u = new URL(referer);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
