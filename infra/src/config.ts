// CDK共通の設定値。環境名・リージョン・暫定パラメータを集約する。
// 暫定値は shared/constants と整合させる（変更しやすさを優先）。

import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  TRASH_RETENTION_DAYS,
  ABORT_INCOMPLETE_MULTIPART_DAYS,
} from '@photo-album/shared';

export interface EnvConfig {
  /** 環境名（dev/prod等）。スタック名のサフィックスに使う。 */
  envName: string;
  region: string;
  /** ごみ箱の保管日数（trash/ のExpiration）。 */
  trashRetentionDays: number;
  /** 未完了マルチパートの破棄日数。 */
  abortIncompleteMultipartDays: number;
  /** 予算アラートの月額上限（USD）。通知のみ。 */
  monthlyBudgetUsd: number;
  /** 予算アラートの通知先メール（任意）。 */
  budgetNotifyEmail?: string;
  /** API Gateway のスロットリング（要件8-11, 暫定）。定常レート（req/秒）。 */
  apiThrottleRateLimit: number;
  /** API Gateway のスロットリング（バースト上限）。 */
  apiThrottleBurstLimit: number;
  /** Lambda ログの保存期間（steering: ログ保存期間を CDK で管理）。 */
  logRetention: RetentionDays;
}

/**
 * デプロイ時の設定を読む CDK context のキー。本番の値は infra/cdk.json に書いて Git で管理する。
 * 以前は環境変数で毎回渡しており、設定し忘れたデプロイで FFmpeg Layer が外れる障害が起きた（2026-11-16）。
 */
export const CONTEXT_KEYS = {
  /** アプリの公開オリジン（CloudFront ドメイン）。例: https://xxxx.cloudfront.net */
  appOrigin: 'photoAlbum:appOrigin',
  /** サムネイル生成 Lambda に付ける FFmpeg Layer。`名前:バージョン`、完全な ARN、または 'none'。 */
  ffmpegLayer: 'photoAlbum:ffmpegLayer',
} as const;

/** FFmpeg Layer を付けずにデプロイすることを明示する値（新しい環境で Layer を作る前など）。 */
export const NO_FFMPEG_LAYER = 'none';

export interface DeploySettings {
  /** アプリの公開オリジン。CloudFront のドメインが未確定の初回デプロイでは空文字。 */
  appOrigin: string;
  /** FFmpeg Layer の指定（`名前:バージョン`・完全な ARN・'none'）。 */
  ffmpegLayer: string;
}

const ORIGIN_PATTERN = /^https?:\/\/[^/\s]+$/;
const LAYER_NAME_VERSION_PATTERN = /^[A-Za-z0-9_-]+:\d+$/;
const LAYER_ARN_PATTERN = /^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:layer:[A-Za-z0-9_-]+:\d+$/;

/**
 * デプロイ時の設定を決める。優先順位: 環境変数（一時的な上書き用）→ infra/cdk.json の context。
 * FFmpeg Layer の指定が無いときはエラーにする（指定漏れのまま Layer が外れたデプロイを防ぐ）。
 */
export function resolveDeploySettings(
  env: NodeJS.ProcessEnv,
  readContext: (key: string) => unknown,
): DeploySettings {
  const fromContext = (key: string): string => {
    const value = readContext(key);
    return typeof value === 'string' ? value.trim() : '';
  };

  const appOrigin = env.APP_ORIGIN?.trim() || fromContext(CONTEXT_KEYS.appOrigin);
  if (appOrigin !== '' && !ORIGIN_PATTERN.test(appOrigin)) {
    throw new Error(
      `公開オリジンの形式が不正です: "${appOrigin}"（例: https://xxxx.cloudfront.net。末尾の / やパスは付けない）`,
    );
  }

  const ffmpegLayer = env.FFMPEG_LAYER_ARN?.trim() || fromContext(CONTEXT_KEYS.ffmpegLayer);
  if (ffmpegLayer === '') {
    throw new Error(
      `FFmpeg Layer の指定がありません。infra/cdk.json の context "${CONTEXT_KEYS.ffmpegLayer}" に ` +
        `"ffmpeg:<バージョン>" を書いてください（Layer なしでデプロイする場合は "${NO_FFMPEG_LAYER}"）。`,
    );
  }
  if (
    ffmpegLayer !== NO_FFMPEG_LAYER &&
    !LAYER_NAME_VERSION_PATTERN.test(ffmpegLayer) &&
    !LAYER_ARN_PATTERN.test(ffmpegLayer)
  ) {
    throw new Error(
      `FFmpeg Layer の指定が不正です: "${ffmpegLayer}"（"名前:バージョン"、Layer の ARN、または "${NO_FFMPEG_LAYER}"）`,
    );
  }

  return { appOrigin, ffmpegLayer };
}

export function loadEnvConfig(): EnvConfig {
  const envName = process.env.ENV_NAME ?? 'dev';
  return {
    envName,
    region: process.env.CDK_REGION ?? 'ap-northeast-1',
    trashRetentionDays: TRASH_RETENTION_DAYS,
    abortIncompleteMultipartDays: ABORT_INCOMPLETE_MULTIPART_DAYS,
    monthlyBudgetUsd: Number(process.env.MONTHLY_BUDGET_USD ?? '20'),
    ...(process.env.BUDGET_NOTIFY_EMAIL
      ? { budgetNotifyEmail: process.env.BUDGET_NOTIFY_EMAIL }
      : {}),
    apiThrottleRateLimit: Number(process.env.API_THROTTLE_RATE ?? '20'),
    apiThrottleBurstLimit: Number(process.env.API_THROTTLE_BURST ?? '40'),
    logRetention: RetentionDays.ONE_MONTH,
  };
}
