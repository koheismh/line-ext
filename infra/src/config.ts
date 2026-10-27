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
