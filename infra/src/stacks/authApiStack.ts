// AuthApiStack: API Gateway HTTP API + API Lambda + 最小権限IAM + SSM 参照。
// design.md「CDKスタック分割」に準拠。削除キューは ProcessingStack から受け取る（Processing → AuthApi の一方向参照）。

import { Duration, Stack, type StackProps, CfnOutput } from 'aws-cdk-lib';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { IQueue } from 'aws-cdk-lib/aws-sqs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import {
  CfnStage,
  HttpApi,
  HttpMethod,
  type CorsHttpMethod,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { EnvConfig } from '../config.js';
import { LAMBDA_RUNTIME, lambdaLogGroup } from '../lambdaDefaults.js';

const here = dirname(fileURLToPath(import.meta.url));
const lambdaDir = join(here, '..', '..', '..', 'backend', 'src', 'lambda');

export interface AuthApiStackProps extends StackProps {
  config: EnvConfig;
  metaBucket: IBucket;
  mediaBucket: IBucket;
  /** 削除キュー。DELETE 受理（202）後に削除ジョブを投入する。 */
  deletionQueue?: IQueue;
  /** アプリの公開オリジン（CloudFrontドメイン）。CSRF/CORS/リダイレクト基点。 */
  allowedOrigin?: string;
  /** LINE コールバックURL。 */
  lineCallbackUrl?: string;
}

export class AuthApiStack extends Stack {
  readonly api: HttpApi;
  readonly apiFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: AuthApiStackProps) {
    super(scope, id, props);
    const { config, metaBucket, mediaBucket } = props;

    // SSM の「パス名」のみを渡す。値は Lambda 実行時に SDK で取得する（secrets.ts）。
    // SecureString のデプロイ時展開制約を避け、秘密を環境変数/テンプレートに平文で残さない。
    const prefix = `/${config.envName}/photo-album`;
    const cookieSecretParam = `${prefix}/cookie-secret`;
    const lineChannelIdParam = `${prefix}/line-channel-id`;
    const lineChannelSecretParam = `${prefix}/line-channel-secret`;

    // API Lambda（NodejsFunction で esbuild バンドル）
    this.apiFn = new NodejsFunction(this, 'ApiFn', {
      runtime: LAMBDA_RUNTIME,
      entry: join(lambdaDir, 'api.ts'),
      handler: 'handler',
      timeout: Duration.seconds(29), // API Gateway HTTP API の最大は30秒
      memorySize: 512,
      environment: {
        META_BUCKET: metaBucket.bucketName,
        MEDIA_BUCKET: mediaBucket.bucketName,
        // 値ではなくSSMパス名を渡す
        COOKIE_SECRET_PARAM: cookieSecretParam,
        LINE_CHANNEL_ID_PARAM: lineChannelIdParam,
        LINE_CHANNEL_SECRET_PARAM: lineChannelSecretParam,
        LINE_CALLBACK_URL: props.lineCallbackUrl ?? '',
        ALLOWED_ORIGIN: props.allowedOrigin ?? '',
        ...(props.deletionQueue ? { DELETION_QUEUE_URL: props.deletionQueue.queueUrl } : {}),
      },
      logGroup: lambdaLogGroup(this, 'ApiFnLogs', config),
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    // 最小権限:
    //  - メタデータ: 読み書き
    //  - メディア: 署名付きURLの発行対象である originals/・previews/ のみ読み取り（trash/ は発行対象にしない）
    //  - メディア: originals/ への書き込み（署名付きPUT・マルチパート・再処理の上書きコピー）
    metaBucket.grantReadWrite(this.apiFn);
    mediaBucket.grantRead(this.apiFn, 'originals/*');
    mediaBucket.grantRead(this.apiFn, 'previews/*');
    mediaBucket.grantPut(this.apiFn, 'originals/*');
    props.deletionQueue?.grantSendMessages(this.apiFn);
    // SSM パラメータの読み取り（復号含む）を対象パスのみに限定して付与
    this.apiFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameters', 'ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${prefix}/*`,
        ],
      }),
    );
    // SecureString 復号のため KMS デフォルトキーの Decrypt を許可（SSM 経由の呼び出しに限定）
    this.apiFn.addToRolePolicy(
      new PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` },
        },
      }),
    );

    // API Gateway HTTP API
    this.api = new HttpApi(this, 'HttpApi', {
      apiName: `photo-album-api-${config.envName}`,
      corsPreflight: {
        allowHeaders: ['content-type', 'authorization'],
        allowMethods: [
          HttpMethod.GET,
          HttpMethod.POST,
          HttpMethod.PATCH,
          HttpMethod.DELETE,
          HttpMethod.OPTIONS,
        ] as unknown as CorsHttpMethod[],
        allowOrigins: [props.allowedOrigin ?? 'https://localhost'],
        allowCredentials: true,
      },
    });

    // スロットリング（要件8-11）。既存の $default ステージを置き換えないよう L1 で設定する
    const defaultStage = this.api.defaultStage?.node.defaultChild as CfnStage | undefined;
    if (defaultStage) {
      defaultStage.defaultRouteSettings = {
        throttlingRateLimit: config.apiThrottleRateLimit,
        throttlingBurstLimit: config.apiThrottleBurstLimit,
      };
    }

    const integration = new HttpLambdaIntegration('ApiIntegration', this.apiFn);
    this.api.addRoutes({ path: '/{proxy+}', methods: [HttpMethod.ANY], integration });

    new CfnOutput(this, 'ApiUrl', { value: this.api.apiEndpoint ?? '' });
    new CfnOutput(this, 'ApiFnArn', { value: this.apiFn.functionArn });
  }
}
