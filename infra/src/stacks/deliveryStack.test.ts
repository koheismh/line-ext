import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StorageStack } from './storageStack.js';
import { ProcessingStack } from './processingStack.js';
import { AuthApiStack } from './authApiStack.js';
import { DeliveryStack } from './deliveryStack.js';
import type { EnvConfig } from '../config.js';

const config: EnvConfig = {
  envName: 'test',
  region: 'ap-northeast-1',
  trashRetentionDays: 30,
  abortIncompleteMultipartDays: 1,
  monthlyBudgetUsd: 20,
  apiThrottleRateLimit: 20,
  apiThrottleBurstLimit: 40,
  logRetention: RetentionDays.ONE_MONTH,
};

// バンドル（esbuild）を伴うため synth は1回だけ行い、各テストで共有する
const { authApi, delivery } = (() => {
  const app = new App();
  const storage = new StorageStack(app, 'Storage', {
    config,
    allowedOrigins: ['https://app.example.com'],
  });
  const processing = new ProcessingStack(app, 'Processing', {
    config,
    metaBucket: storage.metaBucket,
    mediaBucket: storage.mediaBucket,
  });
  const authApiStack = new AuthApiStack(app, 'AuthApi', {
    config,
    metaBucket: storage.metaBucket,
    mediaBucket: storage.mediaBucket,
    deletionQueue: processing.deletionQueue,
    allowedOrigin: 'https://app.example.com',
    lineCallbackUrl: 'https://app.example.com/api/auth/line/callback',
  });
  const deliveryStack = new DeliveryStack(app, 'Delivery', { config, api: authApiStack.api });
  return {
    authApi: Template.fromStack(authApiStack),
    delivery: Template.fromStack(deliveryStack),
  };
})();

describe('AuthApiStack', () => {
  it('HTTP API と API Lambda（現行LTSランタイム・ログ保存期間付き）を作成', () => {
    authApi.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    authApi.resourceCountIs('AWS::Lambda::Function', 1);
    authApi.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs24.x' });
    authApi.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });

  it('ANY /{proxy+} ルートを持つ', () => {
    authApi.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'ANY /{proxy+}',
    });
  });

  it('スロットリングを有効にする（要件8-11）', () => {
    authApi.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
    });
  });

  it('削除キューのURLを環境変数で受け取り、送信権限を持つ', () => {
    authApi.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ DELETION_QUEUE_URL: Match.anyValue() }) },
    });
    authApi.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(['sqs:SendMessage']) }),
        ]),
      },
    });
  });

  it('メディアの読み取りは originals/・previews/ のみ（trash/ を含むバケット全体を付与しない）', () => {
    const policies = Object.values(authApi.findResources('AWS::IAM::Policy'));
    const s3ObjectResources: string[] = [];
    for (const p of policies) {
      const statements = (p as { Properties: { PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] } } })
        .Properties.PolicyDocument.Statement;
      for (const st of statements) {
        const actions = Array.isArray(st.Action) ? st.Action : [st.Action];
        if (!actions.some((a) => a.startsWith('s3:GetObject'))) continue;
        const resources = Array.isArray(st.Resource) ? st.Resource : [st.Resource];
        for (const r of resources) s3ObjectResources.push(JSON.stringify(r));
      }
    }
    const media = s3ObjectResources.filter((r) => r.includes('MediaBucket') && r.includes('/'));
    expect(media.length).toBeGreaterThan(0);
    for (const r of media) {
      expect(r).toMatch(/\/(originals|previews)\/\*/);
    }
  });
});

describe('DeliveryStack', () => {
  it('非公開の静的フロントバケットを作成', () => {
    delivery.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }),
    });
  });

  it('CloudFront Distribution と SPA書き換えFunctionがありAPIビヘイビアを持つ', () => {
    delivery.resourceCountIs('AWS::CloudFront::Distribution', 1);
    delivery.resourceCountIs('AWS::CloudFront::Function', 1);
    delivery.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: '/api/*' }),
        ]),
      }),
    });
  });
});
