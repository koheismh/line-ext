// 秘密情報を Lambda 実行時に SSM Parameter Store から取得する（handler層）。
// 設計方針: CDK は SSM の「パス名」のみを環境変数で渡し、値はデプロイ時に展開しない。
//   - SecureString のデプロイ時展開制約を回避
//   - 秘密がCloudFormationテンプレート/環境変数の平文に残らない
// 取得値はプロセス内（コールドスタート単位）でキャッシュする。

import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

export interface Secrets {
  cookieSecret: string;
  lineChannelId: string;
  lineChannelSecret: string;
}

let cached: Secrets | null = null;

/** 必須の環境変数（SSMパス名）を取得する。 */
function paramName(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`必須の環境変数 ${key}（SSMパス名）が未設定です。`);
  return v;
}

/**
 * SSM から秘密をまとめて取得する（SecureString は復号して取得）。
 * プロセス内キャッシュあり。
 */
export async function loadSecrets(env: NodeJS.ProcessEnv = process.env): Promise<Secrets> {
  if (cached) return cached;

  const names = {
    cookie: paramName(env, 'COOKIE_SECRET_PARAM'),
    channelId: paramName(env, 'LINE_CHANNEL_ID_PARAM'),
    channelSecret: paramName(env, 'LINE_CHANNEL_SECRET_PARAM'),
  };

  const res = await ssm.send(
    new GetParametersCommand({
      Names: [names.cookie, names.channelId, names.channelSecret],
      WithDecryption: true,
    }),
  );

  const map = new Map((res.Parameters ?? []).map((p) => [p.Name, p.Value ?? '']));
  const cookieSecret = map.get(names.cookie);
  const lineChannelId = map.get(names.channelId);
  const lineChannelSecret = map.get(names.channelSecret);

  if (!cookieSecret || !lineChannelId || !lineChannelSecret) {
    const missing = (res.InvalidParameters ?? []).join(', ');
    throw new Error(`SSMから秘密を取得できませんでした（未設定: ${missing || '不明'}）。`);
  }

  cached = { cookieSecret, lineChannelId, lineChannelSecret };
  return cached;
}

/** テスト用にキャッシュをクリアする。 */
export function clearSecretsCache(): void {
  cached = null;
}
