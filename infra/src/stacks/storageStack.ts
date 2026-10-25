// StorageStack: メタデータ/メディアS3バケットと Lifecycle・CORS・Budgets。
// design.md「CDKスタック分割」「S3レイアウト」、security.md、requirements 要件7/8 に準拠。
// - Block Public Access 全面有効
// - 誤削除防止のため RemovalPolicy.RETAIN
// - trash/ のみ Expiration、AbortIncompleteMultipartUpload は全体
// - メディアバケットCORS（PUT、ExposeHeaders に ETag）
// - AWS Budgets（通知のみ・自動停止しない）

import { Duration, RemovalPolicy, Stack, type StackProps, CfnOutput } from 'aws-cdk-lib';
import {
  Bucket,
  BlockPublicAccess,
  BucketEncryption,
  HttpMethods,
  type CorsRule,
} from 'aws-cdk-lib/aws-s3';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';

export interface StorageStackProps extends StackProps {
  config: EnvConfig;
  /** メディアバケットCORSで許可するオリジン。配信ドメイン確定前は暫定で全許可を避け '*' は使わない。 */
  allowedOrigins: string[];
}

export class StorageStack extends Stack {
  readonly metaBucket: Bucket;
  readonly mediaBucket: Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const { config, allowedOrigins } = props;

    // 共通のバケット安全設定
    const secureDefaults = {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN, // 誤削除防止
      versioned: false, // 初期は無効（暫定）
    };

    // メタデータバケット（S3 JSON）
    this.metaBucket = new Bucket(this, 'MetaBucket', {
      ...secureDefaults,
    });

    // メディアバケット（原本・プレビュー・ごみ箱）
    const mediaCors: CorsRule = {
      allowedOrigins,
      allowedMethods: [HttpMethods.PUT, HttpMethods.GET, HttpMethods.HEAD],
      allowedHeaders: ['*'],
      // マルチパート完了に必要な ETag をブラウザから読めるようにする
      exposedHeaders: ['ETag'],
      maxAge: 3000,
    };

    this.mediaBucket = new Bucket(this, 'MediaBucket', {
      ...secureDefaults,
      cors: [mediaCors],
      eventBridgeEnabled: true, // ProcessingStack が EventBridge 経由でイベントを受ける

      lifecycleRules: [
        {
          // 未完了マルチパートを破棄（コスト対策）。全体に適用。
          id: 'abort-incomplete-multipart',
          abortIncompleteMultipartUploadAfter: Duration.days(
            config.abortIncompleteMultipartDays,
          ),
        },
        {
          // trash/ のみ Expiration。originals/・previews/ には適用しない。
          id: 'expire-trash',
          prefix: 'trash/',
          expiration: Duration.days(config.trashRetentionDays),
        },
      ],
    });

    // 予算アラート（通知のみ・利用は自動停止しない）
    new CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `photo-album-${config.envName}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: config.monthlyBudgetUsd, unit: 'USD' },
      },
      ...(config.budgetNotifyEmail
        ? {
            notificationsWithSubscribers: [
              {
                notification: {
                  notificationType: 'ACTUAL',
                  comparisonOperator: 'GREATER_THAN',
                  threshold: 80,
                  thresholdType: 'PERCENTAGE',
                },
                subscribers: [
                  { subscriptionType: 'EMAIL', address: config.budgetNotifyEmail },
                ],
              },
            ],
          }
        : {}),
    });

    new CfnOutput(this, 'MetaBucketName', { value: this.metaBucket.bucketName });
    new CfnOutput(this, 'MediaBucketName', { value: this.mediaBucket.bucketName });
  }
}
