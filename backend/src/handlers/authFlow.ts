// 認証フローのHTTPハンドラ（handler層）。requirements 要件1。
//  GET  /api/auth/line/start    : state/nonce/PKCE生成 → 一時署名Cookie保存 → LINE認可URLへ302
//  GET  /api/auth/line/callback : state照合 → コード交換 → IDトークン検証 → ユーザーupsert → セッションCookie発行 → 戻り先へ302
//  POST /api/auth/logout        : sessionVersion++ → Cookieクリア

import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { generateState, generateNonce, generatePkce } from '../auth/pkce.js';
import { signSession, verifySession } from '../auth/session.js';
import { buildSessionCookie, buildClearSessionCookie, readSessionCookie } from '../auth/cookie.js';
import { safeReturnPath } from '../auth/redirect.js';
import { verifyLineIdToken } from '../auth/oidc.js';
import {
  exchangeLineCode,
  upsertUserFromLine,
  getSessionVersion,
  bumpSessionVersion,
} from '../app/auth.js';
import type { RuntimeConfig } from './runtimeConfig.js';
import { ok, redirect, type HttpResponse } from './http.js';

const LINE_AUTHORIZE_URL = 'https://access.line.me/oauth2/v2.1/authorize';
const TX_COOKIE = 'oauth_tx';

/** 認可開始時の一時情報（署名Cookieに格納）。 */
interface OauthTx {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  // signSession は { userId, sessionVersion } 型なので汎用署名を別に用意する
}

/** 汎用の署名付きCookieはsignSessionを流用せず、JSONをHMAC署名する簡易実装にする。 */
import { createHmac, timingSafeEqual } from 'node:crypto';

function signTx(tx: OauthTx, secret: string): string {
  const body = Buffer.from(JSON.stringify(tx), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyTx(token: string, secret: string): OauthTx | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OauthTx;
  } catch {
    return null;
  }
}

function txCookie(token: string): string {
  // 短命（10分）。認可フロー中のみ有効。
  return `${TX_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}
function clearTxCookie(): string {
  return `${TX_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
function readCookie(event: APIGatewayProxyEventV2, name: string): string | null {
  const cookies = event.cookies ?? [];
  for (const c of cookies) {
    const idx = c.indexOf('=');
    if (idx > 0 && c.slice(0, idx).trim() === name) return c.slice(idx + 1);
  }
  return null;
}

/** GET /api/auth/line/start */
export function handleLineStart(event: APIGatewayProxyEventV2, cfg: RuntimeConfig): HttpResponse {
  const q = event.queryStringParameters ?? {};
  const returnTo = safeReturnPath(q.returnTo);
  const state = generateState();
  const nonce = generateNonce();
  const pkce = generatePkce();

  const tx: OauthTx = { state, nonce, codeVerifier: pkce.verifier, returnTo };
  const txToken = signTx(tx, cfg.secrets.cookieSecret);

  const authUrl = new URL(LINE_AUTHORIZE_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', cfg.secrets.lineChannelId);
  authUrl.searchParams.set('redirect_uri', cfg.lineCallbackUrl);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('scope', 'openid profile');
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return redirect(authUrl.toString(), [txCookie(txToken)]);
}

/** GET /api/auth/line/callback */
export async function handleLineCallback(
  event: APIGatewayProxyEventV2,
  cfg: RuntimeConfig,
): Promise<HttpResponse> {
  const q = event.queryStringParameters ?? {};

  // ユーザーがキャンセル/エラーの場合
  if (q.error) {
    return redirect(`${cfg.allowedOrigin}/?login_error=1`, [clearTxCookie()]);
  }

  const txToken = readCookie(event, TX_COOKIE);
  const tx = txToken ? verifyTx(txToken, cfg.secrets.cookieSecret) : null;
  if (!tx || !q.code || !q.state || q.state !== tx.state) {
    return redirect(`${cfg.allowedOrigin}/?login_error=1`, [clearTxCookie()]);
  }

  // コード交換
  const { idToken } = await exchangeLineCode({
    code: q.code,
    redirectUri: cfg.lineCallbackUrl,
    channelId: cfg.secrets.lineChannelId,
    channelSecret: cfg.secrets.lineChannelSecret,
    codeVerifier: tx.codeVerifier,
  });

  // IDトークン検証
  const verified = await verifyLineIdToken({
    idToken,
    channelId: cfg.secrets.lineChannelId,
    expectedNonce: tx.nonce,
  });
  if (!verified.ok) {
    return redirect(`${cfg.allowedOrigin}/?login_error=1`, [clearTxCookie()]);
  }

  // ユーザーupsert → セッションCookie発行
  const now = new Date().toISOString();
  const displayName = verified.token.name ?? 'LINEユーザー';
  const userId = await upsertUserFromLine(cfg.app, verified.token.sub, displayName, now);
  const sessionVersion = await getSessionVersion(cfg.app, userId);
  const sessionToken = signSession({ userId, sessionVersion }, cfg.secrets.cookieSecret);

  return redirect(`${cfg.allowedOrigin}${tx.returnTo}`, [
    clearTxCookie(),
    buildSessionCookie(sessionToken),
  ]);
}

/** POST /api/auth/logout */
export async function handleLogout(
  event: APIGatewayProxyEventV2,
  cfg: RuntimeConfig,
): Promise<HttpResponse> {
  const token = readSessionCookie((event.cookies ?? []).join('; '));
  const payload = token ? verifySession(token, cfg.secrets.cookieSecret) : null;
  if (payload) {
    await bumpSessionVersion(cfg.app, payload.userId);
  }
  return ok({ ok: true }, { cookies: [buildClearSessionCookie()] });
}
