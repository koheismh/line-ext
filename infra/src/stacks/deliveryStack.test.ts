import { describe, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { StorageStack } from './storageStack.js';
import { AuthApiStack } from './authApiStack.js';
import { DeliveryStack } from './deliveryStack.js';
import type { EnvConfig } from '../config.js';

const config: EnvConfig = {
  envName: 'test',
  region: 'ap-northeast-1',
  trashRetentionDays: 30,
  abortIncompleteMultipartDays: 1,
  monthlyBudgetUsd: 20,
};

function build() {
  const app = new App();
  const storage = new StorageStack(app, 'Storage', {
    config,
    allowedOrigins: ['https://app.example.com'],
  });
  const authApi = new AuthApiStack(app, 'AuthApi', {
    config,
    metaBucket: storage.metaBucket,
    mediaBucket: storage.mediaBucket,
  });
  const delivery = new DeliveryStack(app, 'Delivery', { config, api: authApi.api });
  return {
    authApi: Template.fromStack(authApi),
    delivery: Template.fromStack(delivery),
  };
}

describe('AuthApiStack', () => {
  it('HTTP API と API Lambda を作成', () => {
    const { authApi } = build();
    authApi.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    authApi.resourceCountIs('AWS::Lambda::Function', 1);
  });

  it('ANY /{proxy+} ルートを持つ', () => {
    const { authApi } = build();
    authApi.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'ANY /{proxy+}',
    });
  });
});

describe('DeliveryStack', () => {
  it('非公開の静的フロントバケットを作成', () => {
    const { delivery } = build();
    delivery.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }),
    });
  });

  it('CloudFront Distribution と SPA書き換えFunctionがありAPIビヘイビアを持つ', () => {
    const { delivery } = build();
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
