// ProcessingStack: サムネイル生成・削除ワーカー・定期掃除。
// design.md「CDKスタック分割」「循環参照の回避策」に準拠。
//  - S3→Lambda を直結せず EventBridge 経由（循環参照回避）。対象は originals/ のみ
//  - 削除は SQS 経由の非同期ワーカー
//  - 定期掃除は EventBridge スケジュール
//  - IAM は対象バケット/プレフィックスに限定（最小権限）
//
// 注: Lambda 関数コードのバンドルは実デプロイ時に行う。ここでは構造とイベント配線を定義する。

import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { Function as LambdaFn, Code } from 'aws-cdk-lib/aws-lambda';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';

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

    // Lambda コードは後続の実装/バンドルで差し替える前提のプレースホルダ。
    const placeholder = Code.fromInline(
      'exports.handler = async () => ({ statusCode: 200 });',
    );

    // ---- サムネイル生成Lambda ----
    const thumbnailFn = new LambdaFn(this, 'ThumbnailFn', {
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: placeholder,
      timeout: Duration.minutes(5),
      memorySize: 2048,
      environment: commonEnv,
    });
    // 最小権限: メタはRW、メディアはoriginals/読み取り + previews/書き込み
    metaBucket.grantReadWrite(thumbnailFn);
    mediaBucket.grantRead(thumbnailFn, 'originals/*');
    mediaBucket.grantPut(thumbnailFn, 'previews/*');

    // EventBridge 経由で originals/ の ObjectCreated を受ける（S3直結しない）
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
    const dlq = new Queue(this, 'DeletionDLQ', {
      retentionPeriod: Duration.days(14),
    });
    const deletionQueue = new Queue(this, 'DeletionQueue', {
      visibilityTimeout: Duration.minutes(6),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    const deletionFn = new LambdaFn(this, 'DeletionWorkerFn', {
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: placeholder,
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: commonEnv,
    });
    metaBucket.grantReadWrite(deletionFn);
    // コピー(originals/previews→trash)と元削除のため read/write/delete
    mediaBucket.grantReadWrite(deletionFn);
    mediaBucket.grantDelete(deletionFn);
    deletionFn.addEventSource(new SqsEventSource(deletionQueue, { batchSize: 1 }));

    // ---- 定期掃除（EventBridge スケジュール）----
    const sweepFn = new LambdaFn(this, 'SweepFn', {
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: placeholder,
      timeout: Duration.minutes(2),
      memorySize: 256,
      environment: { ...commonEnv, DELETION_QUEUE_URL: deletionQueue.queueUrl },
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
