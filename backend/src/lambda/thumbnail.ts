// サムネイル生成 Lambda。EventBridge 経由の S3 Object Created(originals/) を受ける。
// キーから albumId/mediaId を抽出し、検証→プレビュー生成→ready を行う。

import type { EventBridgeEvent } from 'aws-lambda';
import { loadAppContext } from '../app/context.js';
import { processUploadedMedia } from '../app/processing.js';
import { createMediaProcessor } from './mediaProcessorS3.js';

interface S3ObjectCreatedDetail {
  bucket: { name: string };
  object: { key: string };
}

/** originals/{albumId}/{mediaId}/source.{ext} から albumId/mediaId を取り出す。 */
export function parseOriginalKey(key: string): { albumId: string; mediaId: string } | null {
  const decoded = decodeURIComponent(key.replace(/\+/g, ' '));
  const m = decoded.match(/^originals\/([^/]+)\/([^/]+)\/source\.[^/]+$/);
  if (!m) return null;
  return { albumId: m[1]!, mediaId: m[2]! };
}

export async function handler(
  event: EventBridgeEvent<'Object Created', S3ObjectCreatedDetail>,
): Promise<void> {
  const ctx = loadAppContext();
  const key = event.detail.object.key;
  const parsed = parseOriginalKey(key);
  if (!parsed) return; // originals/ 以外は無視（本来 EventBridge ルールで絞られる）

  const processor = createMediaProcessor(ctx.mediaBucket);
  await processUploadedMedia(ctx, parsed.albumId, parsed.mediaId, processor);
}
