// ログイン後の戻り先の検証（純粋関数）。
// requirements 要件1-9: 戻り先は同一オリジンの相対パスに限る（オープンリダイレクト対策）。

/**
 * 戻り先として安全なパスに正規化する。
 * - 同一オリジンの相対パス（"/" 始まり）のみ許可
 * - "//" や "/\" で始まるもの（プロトコル相対・別オリジン誘導）は拒否
 * - 絶対URL（http:, https:, 任意スキーム）は拒否
 * - 制御文字を含むものは拒否
 * 不正なら既定の "/" を返す。
 */
export function safeReturnPath(input: string | null | undefined, fallback = '/'): string {
  if (!input) return fallback;
  // 制御文字や空白の混入を拒否（制御文字の検出は意図的なため no-control-regex を無効化）
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(input)) return fallback;
  // 相対パスでなければ拒否
  if (!input.startsWith('/')) return fallback;
  // プロトコル相対 "//host" や "/\host" を拒否
  if (input.startsWith('//') || input.startsWith('/\\')) return fallback;
  // バックスラッシュ始まりを拒否
  if (input.startsWith('\\')) return fallback;
  return input;
}
