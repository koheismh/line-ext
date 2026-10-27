import { describe, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StorageStack } from './storageStack.js';
import type { EnvConfig } from '../config.js';

const config: EnvConfig = {
  envName: 'test',
  region: 'ap-northeast-1',
  trashRetentionDays: 30,
  abortIncompleteMultipartDays: 1,
  monthlyBudgetUsd: 20,
  budgetNotifyEmail: 'ops@example.com',
  apiThrottleRateLimit: 20,
  apiThrottleBurstLimit: 40,
  logRetention: RetentionDays.ONE_MONTH,
};

function synth() {
  const app = new App();
  const stack = new StorageStack(app, 'Storage', {
    config,
    allowedOrigins: ['https://app.example.com'],
  });
  return Template.fromStack(stack);
}

describe('StorageStack', () => {
  it('2つのS3バケットを作成し、いずれもパブリックアクセス全ブロック', () => {
    const t = synth();
    t.resourceCountIs('AWS::S3::Bucket', 2);
    t.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('バケットは誤削除防止で Retain', () => {
    const t = synth();
    t.allResources('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
    });
  });

  it('メディアバケットに trash/ の Expiration(30日) がある', () => {
    const t = synth();
    t.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Prefix: 'trash/', ExpirationInDays: 30 }),
        ]),
      },
    });
  });

  it('メディアバケットに AbortIncompleteMultipartUpload(1日) がある', () => {
    const t = synth();
    t.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }),
        ]),
      },
    });
  });

  it('メディアバケットCORSは PUT を許可し ETag を公開', () => {
    const t = synth();
    t.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: Match.arrayWith([
          Match.objectLike({
            AllowedMethods: Match.arrayWith(['PUT']),
            ExposedHeaders: Match.arrayWith(['ETag']),
            AllowedOrigins: ['https://app.example.com'],
          }),
        ]),
      },
    });
  });

  it('月額予算アラート（Budget）を作成', () => {
    const t = synth();
    t.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetType: 'COST',
        TimeUnit: 'MONTHLY',
      }),
    });
  });
});
