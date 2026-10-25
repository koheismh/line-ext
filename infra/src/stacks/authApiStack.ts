// AuthApiStack: API Gateway HTTP API + API Lambda + 最小権限IAM + SSM 参照。
// design.md「CDKスタック分割」に準拠。

import { Duration, Stack, type StackProps, CfnOutput } from 'aws-cdk-lib';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import {
  HttpApi,
  HttpMethod,
  type CorsHttpMethod,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { EnvConfig } from '../config.js';

const here = dirname(fileURLToPath(import.meta.url));
const lambdaDir = join(here, '..', '..', '..', 'backend', 'src', 'lambda');

export interface AuthApiStackProps extends StackProps {
  config: EnvConfig;
  metaBucket: IBucket;
  mediaBucket: IBucket;
  /** 削除キューURL。削除202後に投入する。 */
  deletionQueueUrl?: string;
}

export class AuthApiStack extends Stack {
  readonly api: HttpApi;
  readonly apiFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: AuthApiStackProps) {
    super(scope, id, props);
    const { config, metaBucket, mediaBucket } = props;

    // SSM からシークレットを参照（CDK synth 時点では値は読み込まない）
    const cookieSecret = StringParameter.valueForSecureStringParameter(
      this,
      `/${config.envName}/photo-album/cookie-secret`,
      1,
    );
    const lineChannelId = StringParameter.valueForStringParameter(
      this,
      `/${config.envName}/photo-album/line-channel-id`,
    );
    const lineChannelSecret = StringParameter.valueForSecureStringParameter(
      this,
      `/${config.envName}/photo-album/line-channel-secret`,
      1,
    );

    // API Lambda（NodejsFunction で esbuild バンドル）
    this.apiFn = new NodejsFunction(this, 'ApiFn', {
      runtime: Runtime.NODEJS_20_X,
      entry: join(lambdaDir, 'api.ts'),
      handler: 'handler',
      timeout: Duration.seconds(29), // API Gateway HTTP API の最大は30秒
      memorySize: 512,
      environment: {
        META_BUCKET: metaBucket.bucketName,
        MEDIA_BUCKET: mediaBucket.bucketName,
        COOKIE_SECRET: cookieSecret,
        LINE_CHANNEL_ID: lineChannelId,
        LINE_CHANNEL_SECRET: lineChannelSecret,
        LINE_CALLBACK_URL: '', // DeliveryStack でドメイン確定後にSSM経由で注入
        ALLOWED_ORIGIN: '', // 同上
        ...(props.deletionQueueUrl
          ? { DELETION_QUEUE_URL: props.deletionQueueUrl }
          : {}),
      },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    // 最小権限: メタはRW、メディアは署名URL発行のためRead
    metaBucket.grantReadWrite(this.apiFn);
    mediaBucket.grantRead(this.apiFn);
    // アップロード署名にCreateMultipartUploadが必要
    mediaBucket.grantPut(this.apiFn, 'originals/*');

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
        allowOrigins: ['https://localhost'], // DeliveryStack 確定後に更新
        allowCredentials: true,
      },
    });

    const integration = new HttpLambdaIntegration('ApiIntegration', this.apiFn);
    this.api.addRoutes({ path: '/{proxy+}', methods: [HttpMethod.ANY], integration });

    new CfnOutput(this, 'ApiUrl', { value: this.api.apiEndpoint ?? '' });
    new CfnOutput(this, 'ApiFnArn', { value: this.apiFn.functionArn });
  }
}
