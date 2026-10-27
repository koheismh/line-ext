// ランタイム設定（handler層）。環境変数から読む。
// 秘密（Cookie署名鍵・LINE Channel ID/Secret）は環境変数に平文で持たせず、
// SSMパス名のみを受け取り、実行時に secrets.ts で取得する（loadSecrets）。

import { loadAppContext, type AppContext } from '../app/context.js';
import { loadSecrets, type Secrets } from './secrets.js';

export interface RuntimeConfig {
  app: AppContext;
  /** 自サイトのオリジン（CSRF/CORS判定・リダイレクト基点）。 */
  allowedOrigin: string;
  /** LINE コールバックURL。 */
  lineCallbackUrl: string;
  /** 削除ジョブを投入するSQSキューURL（未設定時は定期掃除の再投入に任せる）。 */
  deletionQueueUrl: string;
  /** 秘密（SSMから取得）。 */
  secrets: Secrets;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`必須の環境変数 ${key} が未設定です。`);
  return v;
}

/**
 * ランタイム設定を構築する。秘密はSSMから取得する（非同期）。
 * ドメイン確定前の初回デプロイでは ALLOWED_ORIGIN / LINE_CALLBACK_URL が空のことがあるため、
 * 空文字を許容し、未設定時は実行時に空として扱う（認証系は設定後に有効化）。
 */
export async function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeConfig> {
  const secrets = await loadSecrets(env);
  return {
    app: loadAppContext(env),
    allowedOrigin: env.ALLOWED_ORIGIN ?? '',
    lineCallbackUrl: env.LINE_CALLBACK_URL ?? '',
    deletionQueueUrl: env.DELETION_QUEUE_URL ?? '',
    secrets,
  };
}

export { required };
