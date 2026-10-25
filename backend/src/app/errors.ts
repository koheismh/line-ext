// app(usecase)層のエラー。HTTPステータスと機械可読コードを保持する。
// handler層でそのまま ApiError + ステータスに変換する。

export type AppErrorStatus = 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422;

export class AppError extends Error {
  readonly status: AppErrorStatus;
  readonly code: string;

  constructor(status: AppErrorStatus, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

/** 未認証（セッション無効）。 */
export function unauthorized(message = 'ログインが必要です。'): AppError {
  return new AppError(401, 'unauthorized', message);
}

/**
 * 閲覧権限がない/存在しない。
 * requirements 8-5: 閲覧権限なしは存在と同じ404に揃える（存在を推測させない）。
 */
export function notFoundOrForbidden(message = '対象が見つかりません。'): AppError {
  return new AppError(404, 'not_found', message);
}

/** 閲覧はできるが操作権限がない（403）。 */
export function forbidden(message = 'この操作を行う権限がありません。'): AppError {
  return new AppError(403, 'forbidden', message);
}
