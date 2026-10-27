// ProcessingStack: サムネイル生成・削除ワーカー・定期掃除。
// design.md「CDKスタック分割」「循環参照の回避策」に準拠。
//  - S3→Lambda を直結せず EventBridge 経由（循環参照回避）。対象は originals/ のみ
//  - 削除は SQS 経由の非同期ワーカー（キューは AuthApiStack の API Lambda からも投入する）
//  - 定期掃除は EventBridge スケジュール
//  - IAM は対象バケット/プレフィックスに限定（最小権限）
//  - Lambda コードは NodejsFunction（esbuild）でバンドル。sharp はネイティブ依存のため external とし、
//    sharp / FFmpeg は Lambda Layer で供給する（SHARP_LAYER_ARN / FFMPEG_LAYER_ARN）。

import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { LayerVersion, type ILayerVersion } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { EnvConfig } from '../config.js';
import { LAMBDA_RUNTIME, lambdaLogGroup } from '../lambdaDefaults.js';

const here = dirname(fileURLToPath(import.meta.url));
/** backend/src/lambda の各エントリへのパス。 */
const lambdaDir = join(here, '..', '..', '..', 'backend', 'src', 'lambda');

export interface ProcessingStackProps extends StackProps {
  config: EnvConfig;
  metaBucket: IBucket;
  mediaBucket: IBucket;
}

export class ProcessingStack extends Stack {
  /** 削除ジョブのキュー。API Lambda（AuthApiStack）が DELETE 受理時に投入する。 */
  readonly deletionQueue: Queue;

  constructor(scope: Construct, id: string, props: ProcessingStackProps) {
    super(scope, id, props);
    const { config, metaBucket, mediaBucket } = props;

    const commonEnv = {
      META_BUCKET: metaBucket.bucketName,
      MEDIA_BUCKET: mediaBucket.bucketName,
    };

    // 画像・動画処理の Lambda Layer（任意）。ARN が環境変数にあればアタッチする。
    //  - SHARP_LAYER_ARN: linux-x64 の sharp（写真プレビュー）
    //  - FFMPEG_LAYER_ARN: /opt/bin/ffmpeg・/opt/bin/ffprobe を含む Layer（動画プレビュー・コーデック判定）
    // 未供給の間は該当メディアが error(preview_failed) になり、配備後に投稿者が再処理できる。
    const processingLayers: ILayerVersion[] = [];
    const sharpLayerArn = process.env.SHARP_LAYER_ARN;
    if (sharpLayerArn) {
      processingLayers.push(LayerVersion.fromLayerVersionArn(this, 'SharpLayer', sharpLayerArn));
    }
    const ffmpegLayerArn = process.env.FFMPEG_LAYER_ARN;
    if (ffmpegLayerArn) {
      processingLayers.push(LayerVersion.fromLayerVersionArn(this, 'FfmpegLayer', ffmpegLayerArn));
    }

    // ---- サムネイル生成Lambda（Sharp / FFmpeg）----
    const thumbnailFn = new NodejsFunction(this, 'ThumbnailFn', {
      runtime: LAMBDA_RUNTIME,
      entry: join(lambdaDir, 'thumbnail.ts'),
      handler: 'handler',
      timeout: Duration.minutes(5),
      memorySize: 2048,
      environment: commonEnv,
      logGroup: lambdaLogGroup(this, 'ThumbnailFnLogs', config),
      ...(processingLayers.length > 0 ? { layers: processingLayers } : {}),
      bundling: {
        // sharp はネイティブバイナリ（Lambda=linux-x64）。開発機(Windows/WSL2無し)では
        // Linux用バイナリを同梱できないため、バンドルから external 扱いで切り離して Layer で供給する。
        externalModules: ['sharp', '@aws-sdk/*'],
      },
    });
    metaBucket.grantReadWrite(thumbnailFn);
    mediaBucket.grantRead(thumbnailFn, 'originals/*');
    mediaBucket.grantPut(thumbnailFn, 'previews/*');
    // 生成中に削除されたメディアのプレビューを片付けるため
    mediaBucket.grantDelete(thumbnailFn, 'previews/*');

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
    this.deletionQueue = new Queue(this, 'DeletionQueue', {
      visibilityTimeout: Duration.minutes(6),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    const deletionFn = new NodejsFunction(this, 'DeletionWorkerFn', {
      runtime: LAMBDA_RUNTIME,
      entry: join(lambdaDir, 'deletionWorker.ts'),
      handler: 'handler',
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: commonEnv,
      logGroup: lambdaLogGroup(this, 'DeletionWorkerFnLogs', config),
      bundling: { externalModules: ['@aws-sdk/*'] },
    });
    metaBucket.grantReadWrite(deletionFn);
    grantTrashMove(mediaBucket, deletionFn);
    deletionFn.addEventSource(new SqsEventSource(this.deletionQueue, { batchSize: 1 }));

    // ---- 定期掃除（EventBridge スケジュール）----
    const sweepFn = new NodejsFunction(this, 'SweepFn', {
      runtime: LAMBDA_RUNTIME,
      entry: join(lambdaDir, 'sweep.ts'),
      handler: 'handler',
      // 失効メディアの残オブジェクトをごみ箱へ退避（コピー）するため余裕を持たせる
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: { ...commonEnv, DELETION_QUEUE_URL: this.deletionQueue.queueUrl },
      logGroup: lambdaLogGroup(this, 'SweepFnLogs', config),
      bundling: { externalModules: ['@aws-sdk/*'] },
    });
    metaBucket.grantReadWrite(sweepFn);
    grantTrashMove(mediaBucket, sweepFn);
    sweepFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['s3:AbortMultipartUpload'],
        resources: [mediaBucket.arnForObjects('originals/*')],
      }),
    );
    this.deletionQueue.grantSendMessages(sweepFn);

    new Rule(this, 'SweepSchedule', {
      schedule: Schedule.rate(Duration.minutes(10)),
      targets: [new LambdaTarget(sweepFn)],
    });
  }
}

/**
 * ごみ箱退避（originals/・previews/ → trash/ のコピー・サイズ検証・元削除）に必要な最小権限。
 * - 読み取り: originals/・previews/（コピー元）と trash/（コピー先のサイズ検証）。
 *   grantRead はバケットへの List も付与するため、存在しないキーの Head が 403 でなく 404 になる
 * - 書き込み: trash/ のみ（CopyObject の宛先）
 * - 削除: originals/・previews/ のみ（trash/ の削除は Lifecycle に任せる）
 */
function grantTrashMove(bucket: IBucket, fn: NodejsFunction): void {
  bucket.grantRead(fn, 'originals/*');
  bucket.grantRead(fn, 'previews/*');
  bucket.grantRead(fn, 'trash/*');
  bucket.grantPut(fn, 'trash/*');
  bucket.grantDelete(fn, 'originals/*');
  bucket.grantDelete(fn, 'previews/*');
}
