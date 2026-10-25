// DeliveryStack: 静的フロントS3 + CloudFront(OAC) + /api/* 転送 + CloudFront Functions(SPA)。
// design.md「循環参照の回避策」に準拠し、静的フロントバケットはこのスタックに置く。

import { RemovalPolicy, Stack, type StackProps, CfnOutput, Fn } from 'aws-cdk-lib';
import { Bucket, BlockPublicAccess, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import {
  Distribution,
  ViewerProtocolPolicy,
  AllowedMethods,
  CachePolicy,
  OriginRequestPolicy,
  Function as CfFunction,
  FunctionCode,
  FunctionEventType,
  type BehaviorOptions,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin, HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import type { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import type { Construct } from 'constructs';
import type { EnvConfig } from '../config.js';

export interface DeliveryStackProps extends StackProps {
  config: EnvConfig;
  api: HttpApi;
}

export class DeliveryStack extends Stack {
  readonly distribution: Distribution;
  readonly frontBucket: Bucket;

  constructor(scope: Construct, id: string, props: DeliveryStackProps) {
    super(scope, id, props);
    const { api } = props;

    // 静的フロントバケット（非公開。CloudFront OAC からのみ参照）
    this.frontBucket = new Bucket(this, 'FrontBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // SPAルーティング: 拡張子のないパスを /index.html に書き換える CloudFront Functions
    // （カスタムエラーレスポンスでの一括 index.html 差し替えは /api/* の 4xx まで化けるため使わない）
    const spaRewrite = new CfFunction(this, 'SpaRewriteFn', {
      code: FunctionCode.fromInline(`
function handler(event) {
  var req = event.request;
  var uri = req.uri;
  // /api/ はそのまま（APIビヘイビアで処理）
  if (uri.startsWith('/api/')) { return req; }
  // 拡張子がなければ SPA エントリへ
  var lastSegment = uri.split('/').pop();
  if (lastSegment.indexOf('.') === -1) { req.uri = '/index.html'; }
  return req;
}
`),
    });

    // API オリジン（HTTP API のドメイン）。apiEndpoint は https://xxxx.execute-api... 形式。
    const apiDomain = Fn.select(1, Fn.split('://', api.apiEndpoint));
    const apiBehavior: BehaviorOptions = {
      origin: new HttpOrigin(apiDomain),
      viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      // APIはキャッシュ無効・Cookie/認可を転送
      cachePolicy: CachePolicy.CACHING_DISABLED,
      originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    this.distribution = new Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.frontBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          { function: spaRewrite, eventType: FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        '/api/*': apiBehavior,
      },
    });

    new CfnOutput(this, 'DistributionDomain', {
      value: this.distribution.distributionDomainName,
    });
    new CfnOutput(this, 'FrontBucketName', { value: this.frontBucket.bucketName });
  }
}
