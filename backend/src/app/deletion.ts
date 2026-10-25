// メディア削除とごみ箱のユースケース（app層）。requirements 要件7 に準拠。
//  - startDelete: 認可→deleting化→deletedDate/退避先キー確定→削除ジョブを返す（SQS投入はhandler）
//  - processDeletionJob: コピー→サイズ検証→元削除→trashed（冪等・途中失敗から再試行）
//  - 不変条件: コピー検証前に元を削除しない。deleting以降はURL発行/一覧から除外。

import {
  DELETING_RETRY_THRESHOLD_MS,
  STALE_MEDIA_TTL_MS,
  type Media,
} from '@photo-album/shared';
import {
  getJsonOrThrow,
  putJsonIfMatch,
  metaKeys,
  mediaKeys,
  copyObject,
  verifyCopiedBySize,
  deleteObject,
  abortMultipartUpload,
  ConflictError,
} from '../repo/index.js';
import { canStartDelete, canTransition } from '../domain/mediaState.js';
import type { AppContext } from './context.js';
import { AppError } from './errors.js';
import { authorizeMediaDelete } from './authorize.js';

const MAX_RETRY = 5;

/** 削除ジョブ（SQSに積む内容）。 */
export interface DeletionJob {
  mediaId: string;
  albumId: string;
}

/** YYYY-MM-DD（UTC）。退避先プレフィックスに使う。 */
function toDeletedDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * 削除を開始する。認可→deleting化（deletedDate/退避先キー確定）。
 * 既に deleting/trashed なら冪等にジョブを返す。
 */
export async function startDelete(
  ctx: AppContext,
  mediaId: string,
  userId: string,
  now: Date,
): Promise<DeletionJob> {
  const access = await authorizeMediaDelete(ctx, mediaId, userId);
  const media = access.media.value;

  // 既に削除進行中/完了なら冪等
  if (media.status === 'deleting' || media.status === 'trashed') {
    return { mediaId, albumId: media.albumId };
  }
  if (!canStartDelete(media.status)) {
    throw new AppError(409, 'not_deletable', 'このメディアは削除できない状態です。');
  }

  const deletedDate = toDeletedDate(now);
  const fromOriginal = mediaKeys.original(media.albumId, mediaId, media.originalExt);
  const fromPreview = mediaKeys.preview(media.albumId, mediaId);
  const toOriginal = mediaKeys.trashOriginal(deletedDate, media.albumId, mediaId, media.originalExt);
  const toPreview = mediaKeys.trashPreview(deletedDate, media.albumId, mediaId);

  const updated: Media = {
    ...media,
    status: 'deleting',
    updatedAt: now.toISOString(),
    trash: {
      deletedDate,
      fromKeys: [fromOriginal, fromPreview],
      toKeys: [toOriginal, toPreview],
      movedAt: null,
    },
  };
  await putJsonIfMatch(
    ctx.metaBucket,
    metaKeys.media(media.albumId, mediaId),
    updated,
    access.media.etag,
  );
  return { mediaId, albumId: media.albumId };
}

/**
 * 削除ジョブを処理する（ワーカー）。
 * コピー→サイズ検証→元削除→trashed。途中失敗は状態を残し、再実行で続きから。
 * 冪等: 既に trashed なら何もしない。
 */
export async function processDeletionJob(ctx: AppContext, job: DeletionJob): Promise<void> {
  const rec = await getJsonOrThrow<Media>(
    ctx.metaBucket,
    metaKeys.media(job.albumId, job.mediaId),
  );
  const media = rec.value;
  if (media.status === 'trashed') return; // 冪等
  if (media.status !== 'deleting' || !media.trash) {
    // deleting 以外は処理対象外（単調性）
    return;
  }

  const { fromKeys, toKeys } = media.trash;
  // 原本/プレビューをそれぞれコピー→検証（存在するものだけ）
  for (let i = 0; i < fromKeys.length; i++) {
    const from = fromKeys[i]!;
    const to = toKeys[i]!;
    await copyObjectIfExists(ctx.mediaBucket, from, to);
  }
  // 全コピー先をサイズ検証してから元を削除（検証前に元を消さない）
  for (let i = 0; i < fromKeys.length; i++) {
    const from = fromKeys[i]!;
    const to = toKeys[i]!;
    const existed = await verifyCopiedBySize(ctx.mediaBucket, from, to);
    // コピー元が存在しない（既に削除済み）場合は verify が false になるが、
    // その場合は既に元が無いので削除をスキップしてよい。
    if (existed) {
      await deleteObject(ctx.mediaBucket, from);
    }
  }
  await markTrashed(ctx, job.albumId, job.mediaId);
}

/** コピー元が存在する場合のみコピーする（存在しなければ何もしない＝再実行で冪等）。 */
async function copyObjectIfExists(bucket: string, from: string, to: string): Promise<void> {
  try {
    await copyObject(bucket, from, to);
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return;
    throw err;
  }
}

/** status=trashed を ETag 条件付きで確定する。 */
async function markTrashed(ctx: AppContext, albumId: string, mediaId: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const rec = await getJsonOrThrow<Media>(ctx.metaBucket, metaKeys.media(albumId, mediaId));
    if (rec.value.status === 'trashed') return;
    if (!canTransition(rec.value.status, 'trashed')) return;
    const updated: Media = {
      ...rec.value,
      status: 'trashed',
      updatedAt: new Date().toISOString(),
      trash: rec.value.trash
        ? { ...rec.value.trash, movedAt: new Date().toISOString() }
        : rec.value.trash,
    };
    try {
      await putJsonIfMatch(ctx.metaBucket, metaKeys.media(albumId, mediaId), updated, rec.etag);
      return;
    } catch (err) {
      if (err instanceof ConflictError && attempt < MAX_RETRY - 1) continue;
      throw err;
    }
  }
}

/**
 * 定期掃除の対象判定（純粋）。
 * - deleting が閾値(10分)以上 → 削除ジョブ再投入
 * - uploading/validating が閾値(24時間)以上 → 失効候補
 */
export function classifyForSweep(
  media: Pick<Media, 'status' | 'updatedAt'>,
  nowMs: number,
): 'retry_delete' | 'expire' | 'none' {
  const ageMs = nowMs - Date.parse(media.updatedAt);
  if (media.status === 'deleting' && ageMs >= DELETING_RETRY_THRESHOLD_MS) {
    return 'retry_delete';
  }
  if (
    (media.status === 'uploading' || media.status === 'validating') &&
    ageMs >= STALE_MEDIA_TTL_MS
  ) {
    return 'expire';
  }
  return 'none';
}

/**
 * 放置メディアを失効させる（status=expired）。残った未完了マルチパートも中断。
 */
export async function expireStaleMedia(
  ctx: AppContext,
  albumId: string,
  mediaId: string,
): Promise<void> {
  const rec = await getJsonOrThrow<Media>(ctx.metaBucket, metaKeys.media(albumId, mediaId));
  const media = rec.value;
  if (!canTransition(media.status, 'expired')) return;
  if (media.uploadId) {
    const key = mediaKeys.original(albumId, mediaId, media.originalExt);
    try {
      await abortMultipartUpload({ bucket: ctx.mediaBucket, key, uploadId: media.uploadId });
    } catch {
      // 既に中断済み/完了済みは無視
    }
  }
  const updated: Media = { ...media, status: 'expired', updatedAt: new Date().toISOString() };
  await putJsonIfMatch(ctx.metaBucket, metaKeys.media(albumId, mediaId), updated, rec.etag);
}
