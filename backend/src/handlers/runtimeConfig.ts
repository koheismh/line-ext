// ランタイム設定（handler層）。環境変数から読む。
// 秘密情報（Cookie署名鍵・LINE Channel Secret）は CDK が SSM SecureString から
// 環境変数へ注入する前提。コードにハードコードしない。

import { loadAppContext, type AppContext } from '../app/context.js';

export interface RuntimeConfig {
  app: AppContext;
  /** 自サイトのオリジン（CSRF/CORS判定・リダイレクト基点）。 */
  allowedOrigin: string;
  /** セッションCookie署名鍵。 */
  cookieSecret: string;
  /** LINE Login チャネルID（audience）。 */
  lineChannelId: string;
  /** LINE Login チャネルシークレット。 */
  lineChannelSecret: string;
  /** LINE コールバックURL。 */
  lineCallbackUrl: string;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`必須の環境変数 ${key} が未設定です。`);
  return v;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    app: loadAppContext(env),
    allowedOrigin: required(env, 'ALLOWED_ORIGIN'),
    cookieSecret: required(env, 'COOKIE_SECRET'),
    lineChannelId: required(env, 'LINE_CHANNEL_ID'),
    lineChannelSecret: required(env, 'LINE_CHANNEL_SECRET'),
    lineCallbackUrl: required(env, 'LINE_CALLBACK_URL'),
  };
}
