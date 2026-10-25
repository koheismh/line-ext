import { describe, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { StorageStack } from './storageStack.js';
import { ProcessingStack } from './processingStack.js';
import type { EnvConfig } from '../config.js';

const config: EnvConfig = {
  envName: 'test',
  region: 'ap-northeast-1',
  trashRetentionDays: 30,
  abortIncompleteMultipartDays: 1,
  monthlyBudgetUsd: 20,
};

function synth() {
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
  return Template.fromStack(processing);
}

describe('ProcessingStack', () => {
  it('Lambda を3つ作成（サムネイル・削除ワーカー・掃除）', () => {
    synth().resourceCountIs('AWS::Lambda::Function', 3);
  });

  it('削除キューとDLQを作成', () => {
    synth().resourceCountIs('AWS::SQS::Queue', 2);
  });

  it('originals/ プレフィックスの EventBridge ルールがある', () => {
    synth().hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        'detail-type': ['Object Created'],
        detail: Match.objectLike({
          object: { key: [{ prefix: 'originals/' }] },
        }),
      }),
    });
  });

  it('定期掃除のスケジュールルールがある', () => {
    synth().hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(10 minutes)',
    });
  });
});
