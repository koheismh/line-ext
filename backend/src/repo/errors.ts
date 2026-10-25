// repo層の例外。上位(usecase/handler)でHTTPステータスへ変換する。

/** ETag条件付き書き込みの競合（HTTP 409 相当）。 */
export class ConflictError extends Error {
  constructor(message = '競合が発生しました。再取得して再試行してください。') {
    super(message);
    this.name = 'ConflictError';
  }
}

/** 正本が存在しない（HTTP 404 相当）。 */
export class NotFoundError extends Error {
  constructor(message = '対象が見つかりません。') {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** 条件付き新規作成で既に存在した（If-None-Match:* 競合）。 */
export class AlreadyExistsError extends Error {
  constructor(message = '既に存在します。') {
    super(message);
    this.name = 'AlreadyExistsError';
  }
}
