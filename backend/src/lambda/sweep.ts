// 定期掃除 Lambda（EventBridge スケジュール）。
// deleting が長い → 削除ジョブ再投入、uploading/validating が長い → 失効（残オブジェクトはごみ箱へ退避）、
// 削除済みアルバムに残った ready/error のメディア → 削除を開始（アルバム削除の途中失敗や、削除と同時に終わった処理の回収）。
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { loadAppContext } from '../app/context.js';
import {
  classifyForSweep,
  expireStaleMedia,
  reapMediaOfDeletedAlbum,
  type DeletionJob,
} from '../app/deletion.js';
import { listKeys, getJson } from '../repo/index.js';
import type { Media } from '@photo-album/shared';

const sqs = new SQSClient({});

export async function handler(): Promise<void> {
  const ctx = loadAppContext();
  const queueUrl = process.env.DELETION_QUEUE_URL;
  const nowMs = Date.now();
  let failures = 0;
  // アルバムが削除済みかの判定を、この実行の間だけ使い回す（メディアごとに読み直さない）
  const albumDeleted = new Map<string, boolean>();

  async function enqueue(job: DeletionJob): Promise<void> {
    if (!queueUrl) return;
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(job) }));
  }

  // media/ 配下を走査（MVP規模向け。大規模化したらインデックス化する）
  let token: string | undefined;
  do {
    const page = await listKeys(ctx.metaBucket, 'media/', token ? { continuationToken: token } : undefined);
    for (const key of page.keys) {
      // 1件の失敗で掃除全体を止めない（次回の実行で再試行される）
      try {
        const rec = await getJson<Media>(ctx.metaBucket, key);
        if (!rec) continue;
        const media = rec.value;
        const verdict = classifyForSweep(media, nowMs);
        if (verdict === 'retry_delete') {
          await enqueue({ mediaId: media.mediaId, albumId: media.albumId });
        } else if (verdict === 'expire') {
          await expireStaleMedia(ctx, media.albumId, media.mediaId);
        } else {
          const job = await reapMediaOfDeletedAlbum(ctx, media, new Date(nowMs), albumDeleted);
          if (job) await enqueue(job);
        }
      } catch (err) {
        failures++;
        console.warn('[sweep] 処理に失敗しました', { key, message: (err as Error).message });
      }
    }
    token = page.nextToken;
  } while (token);

  if (failures > 0) console.warn('[sweep] 失敗件数', { failures });
}
