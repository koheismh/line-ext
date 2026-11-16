// ProcessingStack: サムネイル生成・削除ワーカー・定期掃除。
// design.md「CDKスタック分割」「循環参照の回避策」に準拠。
//  - S3→Lambda を直結せず EventBridge 経由（循環参照回避）。対象は originals/ のみ
//  - 削除は SQS 経由の非同期ワーカー（キューは AuthApiStack の API Lambda からも投入する）
//  - 定期掃除は EventBridge スケジュール
//  - IAM は対象バケット/プレフィックスに限定（最小権限）
//  - Lambda コードは NodejsFunction（esbuild）でバンドル。写真・動画のプレビューに使う FFmpeg は
//    ネイティブバイナリのため Lambda Layer で供給する（infra/cdk.json の context "photoAlbum:ffmpegLayer"）。

import { Annotations, ArnFormat, Duration, Stack, type StackProps } from 'aws-cdk-lib';
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
import { NO_FFMPEG_LAYER, type EnvConfig } from '../config.js';
import { LAMBDA_RUNTIME, lambdaLogGroup } from '../lambdaDefaults.js';

const here = dirname(fileURLToPath(import.meta.url));
/** backend/src/lambda の各エントリへのパス。 */
const lambdaDir = join(here, '..', '..', '..', 'backend', 'src', 'lambda');

export interface ProcessingStackProps extends StackProps {
  config: EnvConfig;
  metaBucket: IBucket;
  mediaBucket: IBucket;
  /**
   * サムネイル生成 Lambda に付ける FFmpeg Layer（/opt/bin/ffmpeg・/opt/bin/ffprobe を含む）。
   * `名前:バージョン`（このスタックと同じアカウント・リージョンの Layer）、完全な ARN、または 'none'。
   * 必須にして、指定漏れのまま Layer が外れたデプロイを防ぐ（値は infra/cdk.json の context）。
   */
  ffmpegLayer: string;
}

/**
 * FFmpeg Layer の指定から ARN を作る。'none' なら undefined。
 * `名前:バージョン` はアカウントIDをリポジトリに書かないよう、テンプレート上で AWS::AccountId から組み立てる。
 */
export function ffmpegLayerArn(stack: Stack, setting: string): string | undefined {
  if (setting === NO_FFMPEG_LAYER) return undefined;
  if (setting.startsWith('arn:')) return setting;
  return stack.formatArn({
    service: 'lambda',
    resource: 'layer',
    resourceName: setting,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  });
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

    // 写真・動画処理の Lambda Layer（プレビュー生成・コーデック判定）。
    // 'none' の間は該当メディアが error(preview_failed) になり、Layer を付けた後に投稿者が再処理できる。
    const processingLayers: ILayerVersion[] = [];
    const layerArn = ffmpegLayerArn(this, props.ffmpegLayer);
    if (layerArn) {
      processingLayers.push(LayerVersion.fromLayerVersionArn(this, 'FfmpegLayer', layerArn));
    } else {
      Annotations.of(this).addWarningV2(
        'photo-album:no-ffmpeg-layer',
        'FFmpeg Layer なしでデプロイします。写真・動画のプレビューは作成されず error(preview_failed) になります。',
      );
    }

    // ---- サムネイル生成Lambda（FFmpeg）----
    const thumbnailFn = new NodejsFunction(this, 'ThumbnailFn', {
      runtime: LAMBDA_RUNTIME,
      entry: join(lambdaDir, 'thumbnail.ts'),
      handler: 'handler',
      timeout: Duration.minutes(5),
      memorySize: 2048,
      environment: commonEnv,
      logGroup: lambdaLogGroup(this, 'ThumbnailFnLogs', config),
      ...(processingLayers.length > 0 ? { layers: processingLayers } : {}),
      bundling: { externalModules: ['@aws-sdk/*'] },
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
