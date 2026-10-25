// ProcessingStack: サムネイル生成・削除ワーカー・定期掃除。
// design.md「CDKスタック分割」「循環参照の回避策」に準拠。
//  - S3→Lambda を直結せず EventBridge 経由（循環参照回避）。対象は originals/ のみ
//  - 削除は SQS 経由の非同期ワーカー
//  - 定期掃除は EventBridge スケジュール
//  - IAM は対象バケット/プレフィックスに限定（最小権限）
//  - Lambda コードは NodejsFunction（esbuild）でバンドル。sharp はネイティブ依存のため
//    バンドルせず nodeModules 指定（実行環境へインストール）。

import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Runtime, LayerVersion, type ILayerVersion } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { EnvConfig } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));
/** backend/src/lambda の各エントリへのパス。 */
const lambdaDir = join(here, '..', '..', '..', 'backend', 'src', 'lambda');

export interface ProcessingStackProps extends StackProps {
  config: EnvConfig;
  metaBucket: IBucket;
  mediaBucket: IBucket;
}

export class ProcessingStack extends Stack {
  constructor(scope: Construct, id: string, props: ProcessingStackProps) {
    super(scope, id, props);
    const { metaBucket, mediaBucket } = props;

    const commonEnv = {
      META_BUCKET: metaBucket.bucketName,
      MEDIA_BUCKET: mediaBucket.bucketName,
    };

    // sharp を提供する Lambda Layer（任意）。環境変数 SHARP_LAYER_ARN があればアタッチする。
    // 例: 公開の sharp Layer ARN（linux-x64, Node20）を設定すると写真プレビューが有効になる。
    const sharpLayers: ILayerVersion[] = [];
    const sharpLayerArn = process.env.SHARP_LAYER_ARN;
    if (sharpLayerArn) {
      sharpLayers.push(LayerVersion.fromLayerVersionArn(this, 'SharpLayer', sharpLayerArn));
    }

    // ---- サムネイル生成Lambda（Sharp 使用。sharp は external。Layer供給時に有効化）----
    const thumbnailFn = new NodejsFunction(this, 'ThumbnailFn', {
      runtime: Runtime.NODEJS_20_X,
      entry: join(lambdaDir, 'thumbnail.ts'),
      handler: 'handler',
      timeout: Duration.minutes(5),
      memorySize: 2048,
      environment: commonEnv,
      ...(sharpLayers.length > 0 ? { layers: sharpLayers } : {}),
      bundling: {
        // sharp はネイティブバイナリ（Lambda=linux-x64）。開発機(Windows/WSL2無し)では
        // Linux用バイナリを同梱できないため、バンドルから external 扱いで切り離す。
        // → 写真プレビューは sharp をLambdaLayerで供給して有効化する（SHARP_LAYER_ARN 設定時）。
        //    未供給の間は sharp の動的importが失敗し error(preview_failed) になる（他機能は動作）。
        externalModules: ['sharp', '@aws-sdk/*'],
      },
    });
    metaBucket.grantReadWrite(thumbnailFn);
    mediaBucket.grantRead(thumbnailFn, 'originals/*');
    mediaBucket.grantPut(thumbnailFn, 'previews/*');

    new Rule(this, 'OriginalCreatedRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: { name: [mediaBucket.bucketName] },
          object: { key: [{ prefix: 'originals/' }] },
        },
      },
      targets: [new LambdaTarget(thumbnailFn)],
    });

    // ---- 削除ワーカー（SQS）----
    const dlq = new Queue(this, 'DeletionDLQ', { retentionPeriod: Duration.days(14) });
    const deletionQueue = new Queue(this, 'DeletionQueue', {
      visibilityTimeout: Duration.minutes(6),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    const deletionFn = new NodejsFunction(this, 'DeletionWorkerFn', {
      runtime: Runtime.NODEJS_20_X,
      entry: join(lambdaDir, 'deletionWorker.ts'),
      handler: 'handler',
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: commonEnv,
      bundling: { externalModules: ['@aws-sdk/*'] },
    });
    metaBucket.grantReadWrite(deletionFn);
    mediaBucket.grantReadWrite(deletionFn);
    mediaBucket.grantDelete(deletionFn);
    deletionFn.addEventSource(new SqsEventSource(deletionQueue, { batchSize: 1 }));

    // ---- 定期掃除（EventBridge スケジュール）----
    const sweepFn = new NodejsFunction(this, 'SweepFn', {
      runtime: Runtime.NODEJS_20_X,
      entry: join(lambdaDir, 'sweep.ts'),
      handler: 'handler',
      timeout: Duration.minutes(2),
      memorySize: 256,
      environment: { ...commonEnv, DELETION_QUEUE_URL: deletionQueue.queueUrl },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });
    metaBucket.grantReadWrite(sweepFn);
    mediaBucket.grantReadWrite(sweepFn);
    deletionQueue.grantSendMessages(sweepFn);

    new Rule(this, 'SweepSchedule', {
      schedule: Schedule.rate(Duration.minutes(10)),
      targets: [new LambdaTarget(sweepFn)],
    });
  }
}
