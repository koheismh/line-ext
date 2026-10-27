// 非同期ジョブの投入（handler層）。削除は API 内でコピーせず SQS 経由のワーカーで行う（design「削除は非同期」）。

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { DeletionJob } from '../app/deletion.js';

const sqs = new SQSClient({});

/**
 * 削除ジョブを SQS に投入する。
 * 投入に失敗しても削除自体は受理済み（status=deleting）で、定期掃除が10分後に再投入するため、
 * ここでは例外を投げずにログのみ残す。
 */
export async function enqueueDeletion(queueUrl: string, job: DeletionJob): Promise<void> {
  if (!queueUrl) {
    console.warn('[jobs] DELETION_QUEUE_URL が未設定のため、定期掃除での再投入に任せます', job);
    return;
  }
  try {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(job) }));
  } catch (err) {
    console.warn('[jobs] 削除ジョブの投入に失敗しました（定期掃除で再投入されます）', {
      ...job,
      message: (err as Error).message,
    });
  }
}
