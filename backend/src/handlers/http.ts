// HTTP入出力の共通処理（handler層）。
// API Gateway HTTP API (payload v2) を前提に、レスポンス整形とエラー変換を行う。

import type { ApiError } from '@photo-album/shared';
import { AppError } from '../app/errors.js';
import { AlreadyExistsError, ConflictError, NotFoundError } from '../repo/errors.js';

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

function errorBody(statusCode: number, body: ApiError): HttpResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

/** エラーを HTTP レスポンスに変換する。想定外は 500（詳細は漏らさず、ログにのみ残す）。 */
export function errorToResponse(err: unknown): HttpResponse {
  if (err instanceof AppError) {
    return errorBody(err.status, { code: err.code, message: err.message });
  }
  // repo層の例外（ETag競合など）は機械可読なコードで返す（design: 競合は409でリトライ可能に）
  if (err instanceof ConflictError) {
    return errorBody(409, {
      code: 'conflict',
      message: '他の操作と競合しました。画面を更新してからもう一度お試しください。',
    });
  }
  if (err instanceof AlreadyExistsError) {
    return errorBody(409, { code: 'already_exists', message: '既に存在します。' });
  }
  if (err instanceof NotFoundError) {
    return errorBody(404, { code: 'not_found', message: '対象が見つかりません。' });
  }
  // 想定外: 詳細をクライアントに出さない（秘密情報を含まないエラー名・メッセージのみ記録）
  console.error('[api] unexpected error', {
    name: (err as Error)?.name,
    message: (err as Error)?.message,
    stack: (err as Error)?.stack,
  });
  return errorBody(500, { code: 'internal_error', message: 'サーバ内部エラーが発生しました。' });
}

/** ハンドラを実行し、例外を安全にレスポンスへ変換するラッパ。 */
export async function handle(fn: () => Promise<HttpResponse>): Promise<HttpResponse> {
  try {
    return await fn();
  } catch (err) {
    return errorToResponse(err);
  }
}
