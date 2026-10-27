// メディア削除とごみ箱のユースケース（app層）。requirements 要件7 に準拠。
//  - startDelete: 認可→deleting化→deletedDate/退避先キー確定→削除ジョブを返す（SQS投入はhandler）
//  - processDeletionJob: コピー→サイズ検証→（全件検証後に）元削除→trashed（冪等・途中失敗から再試行）
//  - expireStaleMedia: 放置メディアの未完了マルチパート中断・残オブジェクトのごみ箱退避→expired
//  - 不変条件: コピー検証前に元を削除しない。deleting以降はURL発行/一覧から除外。

import {
  DELETING_RETRY_THRESHOLD_MS,
  STALE_MEDIA_TTL_MS,
  type Album,
  type Media,
  type MediaTrashInfo,
} from '@photo-album/shared';
import {
  getJsonOrThrow,
  putJsonIfMatch,
  metaKeys,
  mediaKeys,
  copyObject,
  headObjectSize,
  deleteObject,
  abortMultipartUpload,
  ConflictError,
} from '../repo/index.js';
import { canStartDelete, canTransition } from '../domain/mediaState.js';
import type { AppContext } from './context.js';
import { AppError } from './errors.js';
import { authorizeMediaDelete } from './authorize.js';
import { recalcCover } from './albums.js';

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

/** 退避元・退避先キーを確定する（再試行でも変えないよう、この結果を JSON に保存する）。 */
function buildTrashInfo(media: Media, now: Date): MediaTrashInfo {
  const deletedDate = toDeletedDate(now);
  return {
    deletedDate,
    fromKeys: [
      mediaKeys.original(media.albumId, media.mediaId, media.originalExt),
      mediaKeys.preview(media.albumId, media.mediaId),
    ],
    toKeys: [
      mediaKeys.trashOriginal(deletedDate, media.albumId, media.mediaId, media.originalExt),
      mediaKeys.trashPreview(deletedDate, media.albumId, media.mediaId),
    ],
    movedAt: null,
  };
}

/**
 * 削除を開始する。認可→deleting化（deletedDate/退避先キー確定）。
 * 既に deleting/trashed なら冪等にジョブを返す。表紙だった場合は表紙を再選定する（要件3-10）。
 */
export async function startDelete(
  ctx: AppContext,
  mediaId: string,
  userId: string,
  now: Date,
): Promise<DeletionJob> {
  const access = await authorizeMediaDelete(ctx, mediaId, userId);
  const media = access.media.value;
  const job: DeletionJob = { mediaId, albumId: media.albumId };

  // 既に削除進行中/完了なら冪等（表紙の再選定だけ再試行する）
  if (media.status === 'deleting' || media.status === 'trashed') {
    await recalcCoverIfNeeded(ctx, access.album, mediaId);
    return job;
  }
  if (!canStartDelete(media.status)) {
    throw new AppError(409, 'not_deletable', 'このメディアは削除できない状態です。');
  }

  const updated: Media = {
    ...media,
    status: 'deleting',
    updatedAt: now.toISOString(),
    trash: buildTrashInfo(media, now),
  };
  try {
    await putJsonIfMatch(
      ctx.metaBucket,
      metaKeys.media(media.albumId, mediaId),
      updated,
      access.media.etag,
    );
  } catch (err) {
    // 二重クリック等で同時に削除開始した場合: 読み直して deleting 以降なら冪等に成功
    if (!(err instanceof ConflictError)) throw err;
    const again = await getJsonOrThrow<Media>(ctx.metaBucket, metaKeys.media(media.albumId, mediaId));
    if (again.value.status !== 'deleting' && again.value.status !== 'trashed') throw err;
  }

  await recalcCoverIfNeeded(ctx, access.album, mediaId);
  return job;
}

/**
 * 表紙だったメディアを消したら再選定する（要件3-10）。
 * 表紙はシステム更新なので、失敗しても削除の受理は取り消さない（ログのみ。次回の再計算で回復する）。
 */
async function recalcCoverIfNeeded(ctx: AppContext, album: Album, mediaId: string): Promise<void> {
  if (album.coverMediaId !== mediaId) return;
  try {
    await recalcCover(ctx, album.albumId, album.ownerType, album.ownerId);
  } catch (err) {
    console.warn('[deletion] 表紙の再選定に失敗しました', {
      albumId: album.albumId,
      message: (err as Error).message,
    });
  }
}

/**
 * fromKeys → toKeys へごみ箱退避する（冪等）。
 * 1. 元が存在するものだけコピーし、コピー先のサイズが元と一致することを確認する
 * 2. 全件の検証が済んでから元を削除する（検証前に元を消さない）
 * 元が存在しない（前回の実行で移動済み・プレビュー未生成）ものはスキップする。
 * 検証に失敗したら例外を投げ、元は残したまま再試行に委ねる。
 */
export async function moveToTrash(
  bucket: string,
  fromKeys: string[],
  toKeys: string[],
): Promise<void> {
  const verified: string[] = [];
  for (let i = 0; i < fromKeys.length; i++) {
    const from = fromKeys[i]!;
    const to = toKeys[i]!;
    const srcSize = await headObjectSize(bucket, from);
    if (srcSize === null) continue;
    await copyObject(bucket, from, to);
    const dstSize = await headObjectSize(bucket, to);
    if (dstSize !== srcSize) {
      throw new Error(`ごみ箱へのコピー検証に失敗しました（${from}）。`);
    }
    verified.push(from);
  }
  for (const from of verified) {
    await deleteObject(bucket, from);
  }
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

  await moveToTrash(ctx.mediaBucket, media.trash.fromKeys, media.trash.toKeys);
  await markTrashed(ctx, job.albumId, job.mediaId);
}

/** status=trashed を ETag 条件付きで確定する。 */
async function markTrashed(ctx: AppContext, albumId: string, mediaId: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const rec = await getJsonOrThrow<Media>(ctx.metaBucket, metaKeys.media(albumId, mediaId));
    if (rec.value.status === 'trashed') return;
    if (!canTransition(rec.value.status, 'trashed')) return;
    const nowIso = new Date().toISOString();
    const updated: Media = {
      ...rec.value,
      status: 'trashed',
      updatedAt: nowIso,
      trash: rec.value.trash ? { ...rec.value.trash, movedAt: nowIso } : rec.value.trash,
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
 * 放置メディアを失効させる（status=expired, 要件7-11）。
 * 1. 未完了マルチパートを中断する
 * 2. 残った原本・プレビューを（直接消さず）ごみ箱へ退避する。退避先は trash 情報として記録する
 * 3. expired に確定する
 * 途中で失敗しても状態は uploading/validating のままなので、次回の定期掃除で続きから再実行される。
 */
export async function expireStaleMedia(
  ctx: AppContext,
  albumId: string,
  mediaId: string,
  now: Date = new Date(),
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

  const trash = media.trash ?? buildTrashInfo(media, now);
  await moveToTrash(ctx.mediaBucket, trash.fromKeys, trash.toKeys);

  const updated: Media = {
    ...media,
    status: 'expired',
    updatedAt: now.toISOString(),
    trash: { ...trash, movedAt: now.toISOString() },
  };
  await putJsonIfMatch(ctx.metaBucket, metaKeys.media(albumId, mediaId), updated, rec.etag);
}
