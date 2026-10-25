// 定期掃除 Lambda（EventBridge スケジュール）。
// deleting が長い → 削除ジョブ再投入、uploading/validating が長い → 失効。
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadAppContext } from '../app/context.js';
import { classifyForSweep, expireStaleMedia, type DeletionJob } from '../app/deletion.js';
import { listKeys, getJson } from '../repo/index.js';
import type { Media } from '@photo-album/shared';

const sqs = new SQSClient({});

export async function handler(): Promise<void> {
  const ctx = loadAppContext();
  const queueUrl = process.env.DELETION_QUEUE_URL;
  const nowMs = Date.now();

  // media/ 配下を走査（MVP規模向け。大規模化したらインデックス化する）
  let token: string | undefined;
  do {
    const page = await listKeys(ctx.metaBucket, 'media/', token ? { continuationToken: token } : undefined);
    for (const key of page.keys) {
      const rec = await getJson<Media>(ctx.metaBucket, key);
      if (!rec) continue;
      const media = rec.value;
      const verdict = classifyForSweep(media, nowMs);
      if (verdict === 'retry_delete' && queueUrl) {
        const job: DeletionJob = { mediaId: media.mediaId, albumId: media.albumId };
        await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(job) }));
      } else if (verdict === 'expire') {
        await expireStaleMedia(ctx, media.albumId, media.mediaId);
      }
    }
    token = page.nextToken;
  } while (token);
}
