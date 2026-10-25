// HTTP入出力の共通処理（handler層）。
// API Gateway HTTP API (payload v2) を前提に、レスポンス整形とエラー変換を行う。

import type { ApiError } from '@photo-album/shared';
import { AppError } from '../app/errors.js';

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  cookies?: string[];
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** 成功レスポンス（JSON）。 */
export function ok(body: unknown, opts?: { statusCode?: number; cookies?: string[] }): HttpResponse {
  return {
    statusCode: opts?.statusCode ?? 200,
    headers: JSON_HEADERS,
    body: JSON.stringify(body ?? {}),
    ...(opts?.cookies ? { cookies: opts.cookies } : {}),
  };
}

/** 空の成功（204/202等）。 */
export function noContent(statusCode = 204, cookies?: string[]): HttpResponse {
  return {
    statusCode,
    headers: {},
    body: '',
    ...(cookies ? { cookies } : {}),
  };
}

/** リダイレクト。 */
export function redirect(location: string, cookies?: string[]): HttpResponse {
  return {
    statusCode: 302,
    headers: { location },
    body: '',
    ...(cookies ? { cookies } : {}),
  };
}

/** エラーを HTTP レスポンスに変換する。想定外は 500（詳細は漏らさない）。 */
export function errorToResponse(err: unknown): HttpResponse {
  if (err instanceof AppError) {
    const body: ApiError = { code: err.code, message: err.message };
    return { statusCode: err.status, headers: JSON_HEADERS, body: JSON.stringify(body) };
  }
  // 想定外: 詳細をクライアントに出さない
  const body: ApiError = { code: 'internal_error', message: 'サーバ内部エラーが発生しました。' };
  return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

/** ハンドラを実行し、例外を安全にレスポンスへ変換するラッパ。 */
export async function handle(fn: () => Promise<HttpResponse>): Promise<HttpResponse> {
  try {
    return await fn();
  } catch (err) {
    return errorToResponse(err);
  }
}
