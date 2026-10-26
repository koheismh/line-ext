// LINE Login v2.1 の IDトークン（OIDC）検証。
// requirements 要件1-2, security.md: 署名・issuer・audience・nonce・exp を検証する。
//
// LINE の id_token は既定で HS256（チャネルシークレットを鍵とする対称署名）。
// 特定設定時のみ ES256（JWKS公開鍵）。alg に応じて検証方法を切り替える。
// 参考: https://developers.line.biz/en/docs/line-login/verify-id-token/

import {
  jwtVerify,
  createRemoteJWKSet,
  decodeProtectedHeader,
  type JWTPayload,
} from 'jose';

const LINE_ISSUER = 'https://access.line.me';
const LINE_JWKS_URL = 'https://api.line.me/oauth2/v2.1/certs';

// ES256 用の JWKS（プロセス内キャッシュ）。HS256 では使わない。
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
  /** LINE チャネルシークレット（HS256 の検証鍵）。 */
  channelSecret: string;
  /** 認可開始時に生成し保持していた nonce。 */
  expectedNonce: string;
}

export type VerifyResult =
  | { ok: true; token: VerifiedLineIdToken }
  | { ok: false; reason: string };

/**
 * IDトークンを検証する。
 * - alg=HS256: チャネルシークレットで検証（LINE既定）
 * - alg=ES256: LINE JWKS で検証
 * - issuer/audience/exp は共通に検証、nonce は一致確認
 */
export async function verifyLineIdToken(params: VerifyParams): Promise<VerifyResult> {
  let payload: JWTPayload;
  try {
    const header = decodeProtectedHeader(params.idToken);
    const options = {
      issuer: LINE_ISSUER,
      audience: params.channelId,
    };

    if (header.alg === 'HS256') {
      const key = new TextEncoder().encode(params.channelSecret);
      ({ payload } = await jwtVerify(params.idToken, key, options));
    } else if (header.alg === 'ES256') {
      ({ payload } = await jwtVerify(params.idToken, jwks, options));
    } else {
      return { ok: false, reason: `未対応のalg: ${String(header.alg)}` };
    }
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
