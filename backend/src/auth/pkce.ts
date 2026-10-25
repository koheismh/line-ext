// OIDC 認可コードフローの state / nonce / PKCE 生成。
// requirements 要件1-1, security.md: state/nonce/PKCE を必須とする。

import { createHash, randomBytes } from 'node:crypto';

/** URLセーフなランダム文字列（base64url）。 */
function randomUrlSafe(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/** CSRF対策の state。 */
export function generateState(): string {
  return randomUrlSafe(32);
}

/** リプレイ対策の nonce（IDトークン検証で突き合わせる）。 */
export function generateNonce(): string {
  return randomUrlSafe(32);
}

export interface Pkce {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/**
 * PKCE の verifier と challenge(S256) を生成する。
 * challenge = base64url(sha256(verifier))
 */
export function generatePkce(): Pkce {
  const verifier = randomUrlSafe(48); // 43〜128文字に収まる長さ
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}
