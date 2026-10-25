// 削除ワーカー Lambda。SQS から削除ジョブを受け、コピー→検証→元削除→trashed を行う。
import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { loadAppContext } from '../app/context.js';
import { processDeletionJob, type DeletionJob } from '../app/deletion.js';

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const ctx = loadAppContext();
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const job = JSON.parse(record.body) as DeletionJob;
      await processDeletionJob(ctx, job);
    } catch {
      // 失敗したメッセージは可視性タイムアウト後に再試行（部分バッチ応答）
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
