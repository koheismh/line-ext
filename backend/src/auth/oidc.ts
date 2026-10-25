// LINE Login v2.1 の IDトークン（OIDC）検証。
// requirements 要件1-2, security.md: 署名・issuer・audience・nonce・exp を検証する。
// 署名検証は LINE の JWKS（公開鍵）で行う。jose を使用。

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const LINE_ISSUER = 'https://access.line.me';
const LINE_JWKS_URL = 'https://api.line.me/oauth2/v2.1/certs';

// JWKS はプロセス内でキャッシュされる（jose が管理）。
const jwks = createRemoteJWKSet(new URL(LINE_JWKS_URL));

export interface VerifiedLineIdToken {
  /** LINE のユーザー識別子（sub）。内部IDの主キーにはしない。 */
  sub: string;
  /** 表示名（存在すれば）。 */
  name: string | null;
}

export interface VerifyParams {
  idToken: string;
  /** LINE チャネルID（audience）。 */
  channelId: string;
  /** 認可開始時に生成し保持していた nonce。 */
  expectedNonce: string;
}

export type VerifyResult =
  | { ok: true; token: VerifiedLineIdToken }
  | { ok: false; reason: string };

/**
 * IDトークンを検証する。
 * - 署名: LINE JWKS
 * - issuer: https://access.line.me
 * - audience: channelId
 * - exp: jose が自動検証
 * - nonce: expectedNonce と一致
 */
export async function verifyLineIdToken(params: VerifyParams): Promise<VerifyResult> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(params.idToken, jwks, {
      issuer: LINE_ISSUER,
      audience: params.channelId,
    });
    payload = result.payload;
  } catch (err) {
    return { ok: false, reason: `idトークン検証失敗: ${(err as Error).message}` };
  }

  // nonce 照合（リプレイ対策）
  if (typeof payload.nonce !== 'string' || payload.nonce !== params.expectedNonce) {
    return { ok: false, reason: 'nonce 不一致' };
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    return { ok: false, reason: 'sub 不在' };
  }

  const name = typeof payload.name === 'string' ? payload.name : null;
  return { ok: true, token: { sub: payload.sub, name } };
}
