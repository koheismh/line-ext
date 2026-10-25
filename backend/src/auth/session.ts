// 署名付きセッション（HMAC-SHA256）。
// requirements 要件1-6〜1-8:
//  - 無期限（有効期限による自動失効はしない）
//  - userId と sessionVersion を含める
//  - ログアウトで users.sessionVersion を上げ、以前の版のCookieを無効化
// Cookie署名鍵は SSM SecureString から渡す（フロント・Gitに置かない）。

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Cookie に載せるセッションの中身。 */
export interface SessionPayload {
  userId: string;
  /** 発行時点の sessionVersion。検証時に正本と照合する。 */
  sessionVersion: number;
}

/** payload を base64url(JSON).署名 の形式で署名する。 */
export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * 署名付きトークンを検証して payload を復元する。
 * 署名不一致・形式不正は null。期限は持たない（無期限）。
 * sessionVersion の照合は呼び出し側で正本と突き合わせる。
 */
export function verifySession(token: string, secret: string): SessionPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  // 長さが違うと timingSafeEqual が例外を投げるため先に比較
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const json = Buffer.from(body, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as SessionPayload).userId === 'string' &&
      typeof (parsed as SessionPayload).sessionVersion === 'number'
    ) {
      return parsed as SessionPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * セッションが現在も有効かを正本の sessionVersion と照合する。
 * ログアウトで版数が上がると、以前の版のCookieは無効になる。
 */
export function isSessionActive(
  payload: SessionPayload,
  currentSessionVersion: number,
): boolean {
  return payload.sessionVersion === currentSessionVersion;
}
