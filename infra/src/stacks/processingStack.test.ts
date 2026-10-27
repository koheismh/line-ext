import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StorageStack } from './storageStack.js';
import { ProcessingStack } from './processingStack.js';
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
const template = (() => {
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
})();

/** ロールのポリシーに含まれる S3 アクション→リソースの組を平坦化する（権限範囲の検証用）。 */
function s3Grants(): { action: string; resource: string }[] {
  const out: { action: string; resource: string }[] = [];
  for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
    const statements = (policy as { Properties: { PolicyDocument: { Statement: unknown[] } } })
      .Properties.PolicyDocument.Statement as { Action: string | string[]; Resource: unknown }[];
    for (const st of statements) {
      const actions = Array.isArray(st.Action) ? st.Action : [st.Action];
      const resources = Array.isArray(st.Resource) ? st.Resource : [st.Resource];
      for (const a of actions.filter((x) => x.startsWith('s3:'))) {
        for (const r of resources) out.push({ action: a, resource: JSON.stringify(r) });
      }
    }
  }
  return out;
}

describe('ProcessingStack', () => {
  it('Lambda を3つ作成（サムネイル・削除ワーカー・掃除）し、現行LTSのランタイムを使う', () => {
    template.resourceCountIs('AWS::Lambda::Function', 3);
    template.allResourcesProperties('AWS::Lambda::Function', { Runtime: 'nodejs24.x' });
  });

  it('Lambda ログに保存期間を設定する', () => {
    template.resourceCountIs('AWS::Logs::LogGroup', 3);
    template.allResourcesProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
  });

  it('削除キューとDLQを作成', () => {
    template.resourceCountIs('AWS::SQS::Queue', 2);
  });

  it('originals/ プレフィックスの EventBridge ルールがある', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        'detail-type': ['Object Created'],
        detail: Match.objectLike({
          object: { key: [{ prefix: 'originals/' }] },
        }),
      }),
    });
  });

  it('定期掃除のスケジュールルールがある', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(10 minutes)',
    });
  });

  it('メディアバケットへの書き込み・削除はプレフィックス限定（バケット全体の * を付与しない）', () => {
    const grants = s3Grants();
    const writes = grants.filter((g) => /^s3:(PutObject|DeleteObject|Abort)/.test(g.action));
    expect(writes.length).toBeGreaterThan(0);
    for (const g of writes) {
      // メタデータバケットへの書き込み（/*）は許容。メディアは originals/・previews/・trash/ に限る
      if (g.resource.includes('MediaBucket')) {
        expect(g.resource).toMatch(/\/(originals|previews|trash)\/\*/);
      }
    }
    // trash/ を削除できるのは Lifecycle だけ
    expect(
      grants.some((g) => g.action.startsWith('s3:DeleteObject') && g.resource.includes('trash/')),
    ).toBe(false);
  });
});
