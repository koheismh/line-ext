// メディア削除・アルバム削除とごみ箱のユースケース（app層）。requirements 要件3-15・要件7 に準拠。
//  - startDelete: 認可→deleting化→deletedDate/退避先キー確定→削除ジョブを返す（SQS投入はhandler）
//  - deleteAlbum: アルバムに墓標を付け、中のメディアを deleting にして削除ジョブを返す
//  - reapMediaOfDeletedAlbum: 削除済みアルバムに残ったメディアを定期掃除で片付ける
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
  getJson,
  getJsonOrThrow,
  putJsonIfMatch,
  listJson,
  metaKeys,
  mediaKeys,
  copyObject,
  headObjectSize,
  deleteObject,
  abortMultipartUpload,
  ConflictError,
  type JsonRecord,
} from '../repo/index.js';
import { canStartDelete, canTransition } from '../domain/mediaState.js';
import type { AppContext } from './context.js';
import { AppError, notFoundOrForbidden } from './errors.js';
import { authorizeAlbumDelete, authorizeMediaDelete } from './authorize.js';
import { getAlbumIncludingDeleted } from './entities.js';
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

  await writeDeleting(ctx, access.media, now);

  await recalcCoverIfNeeded(ctx, access.album, mediaId);
  return job;
}

/**
 * メディアを deleting にして、退避先キーを確定・保存する（認可は呼び出し側で済ませる）。
 * 二重クリック等で同時に削除開始されて競合した場合は、読み直して deleting 以降なら冪等に成功する。
 */
async function writeDeleting(ctx: AppContext, rec: JsonRecord<Media>, now: Date): Promise<void> {
  const media = rec.value;
  const updated: Media = {
    ...media,
    status: 'deleting',
    updatedAt: now.toISOString(),
    trash: buildTrashInfo(media, now),
  };
  const key = metaKeys.media(media.albumId, media.mediaId);
  try {
    await putJsonIfMatch(ctx.metaBucket, key, updated, rec.etag);
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
    const again = await getJsonOrThrow<Media>(ctx.metaBucket, key);
    if (again.value.status !== 'deleting' && again.value.status !== 'trashed') throw err;
  }
}

/**
 * 認可済みの文脈で、メディアの削除を始める（アルバム削除と定期掃除が使う）。冪等。
 * 削除ジョブを積むべきなら返し、積む必要がなければ null。
 * - ready / error → deleting にして返す
 * - すでに deleting → 返す（ワーカーは冪等。取りこぼしの再投入にも使える）
 * - trashed / expired → null（済んでいる）
 * - uploading / validating → null（途中の処理を壊さない。放置されたら24時間後の失効で片付く）
 */
export async function startDeletingMedia(
  ctx: AppContext,
  albumId: string,
  mediaId: string,
  now: Date,
): Promise<DeletionJob | null> {
  const rec = await getJson<Media>(ctx.metaBucket, metaKeys.media(albumId, mediaId));
  if (!rec) return null;
  const status = rec.value.status;
  if (status === 'deleting') return { mediaId, albumId };
  if (!canStartDelete(status)) return null;
  await writeDeleting(ctx, rec, now);
  return { mediaId, albumId };
}

/** アルバム削除で、メディアを deleting にする処理に使える時間（API Gateway の30秒に収める）。 */
const ALBUM_MEDIA_BUDGET_MS = 12_000;
/** 同時に処理するメディア数。 */
const ALBUM_MEDIA_CONCURRENCY = 8;

/**
 * アルバムを削除する（作成者またはグループ管理者。個人アルバムは所有者）。要件3-15。
 * 1. アルバムに削除済みの印（deletedAt）を付ける。この時点で全員の一覧・閲覧・アップロード・コメントから外れる
 * 2. 中のメディア（ready / error）を deleting にして、削除ジョブを返す（SQS投入は handler）
 *    → あとは既存の削除ワーカーが、メディア1件ごとに「コピー検証 → 元を削除 → trashed」を行う
 * 途中で止まっても、定期掃除が削除済みアルバムに残ったメディアを見つけて続きを行う（reapMediaOfDeletedAlbum）。
 * 二重実行は冪等: 削除済みなら、削除した本人にだけ成功を返す（残りのメディアの処理も続ける）。それ以外は404。
 */
export async function deleteAlbum(
  ctx: AppContext,
  albumId: string,
  userId: string,
  now: Date,
): Promise<DeletionJob[]> {
  for (let attempt = 0; ; attempt++) {
    const existing = await getAlbumIncludingDeleted(ctx, albumId);
    if (!existing) throw notFoundOrForbidden();
    if (existing.value.deletedAt) {
      if (existing.value.deletedBy !== userId) throw notFoundOrForbidden();
      break;
    }
    const access = await authorizeAlbumDelete(ctx, albumId, userId);
    const album = access.album.value;
    const updated: Album = {
      ...album,
      deletedAt: now.toISOString(),
      deletedBy: userId,
      updatedAt: now.toISOString(),
    };
    try {
      await putJsonIfMatch(
        ctx.metaBucket,
        metaKeys.album(album.ownerType, album.ownerId, albumId),
        updated,
        access.album.etag,
      );
      break;
    } catch (err) {
      // 表紙の自動設定などのシステム更新と競合したら、読み直してやり直す
      if (err instanceof ConflictError && attempt < MAX_RETRY - 1) continue;
      throw err;
    }
  }
  return startDeletingAlbumMedia(ctx, albumId, now);
}

/** 削除済みアルバムの中のメディアを deleting にして、積むべき削除ジョブを集める。 */
async function startDeletingAlbumMedia(
  ctx: AppContext,
  albumId: string,
  now: Date,
): Promise<DeletionJob[]> {
  const medias = await listJson<Media>(ctx.metaBucket, metaKeys.mediaPrefix(albumId));
  const targets = medias.filter(
    (m) => m.status === 'ready' || m.status === 'error' || m.status === 'deleting',
  );
  const deadline = Date.now() + ALBUM_MEDIA_BUDGET_MS;
  const jobs: DeletionJob[] = [];
  for (let i = 0; i < targets.length; i += ALBUM_MEDIA_CONCURRENCY) {
    if (Date.now() > deadline) {
      console.warn('[deletion] アルバム内のメディアの処理が時間内に終わらなかったため、残りは定期掃除に任せます', {
        albumId,
        remaining: targets.length - i,
      });
      break;
    }
    const batch = targets.slice(i, i + ALBUM_MEDIA_CONCURRENCY);
    const results = await Promise.all(
      batch.map((m) =>
        startDeletingMedia(ctx, albumId, m.mediaId, now).catch((err: Error) => {
          // 1件の失敗で他を止めない。残りは定期掃除が続ける
          console.warn('[deletion] メディアの削除開始に失敗しました（定期掃除が続けます）', {
            albumId,
            mediaId: m.mediaId,
            message: err.message,
          });
          return null;
        }),
      ),
    );
    for (const job of results) if (job) jobs.push(job);
  }
  return jobs;
}

/**
 * 削除済みアルバムに残ったメディアを片付ける（定期掃除から呼ぶ）。積むべき削除ジョブを返す。
 * アルバム削除の途中失敗や、削除と同時に処理が終わって ready になったメディアを拾う。
 * albumDeleted はこの実行の間だけ使うアルバム単位のキャッシュ（メディアごとにアルバムを読み直さない）。
 */
export async function reapMediaOfDeletedAlbum(
  ctx: AppContext,
  media: Pick<Media, 'albumId' | 'mediaId' | 'status'>,
  now: Date,
  albumDeleted: Map<string, boolean>,
): Promise<DeletionJob | null> {
  if (media.status !== 'ready' && media.status !== 'error') return null;
  let deleted = albumDeleted.get(media.albumId);
  if (deleted === undefined) {
    const album = await getAlbumIncludingDeleted(ctx, media.albumId);
    deleted = !!album?.value.deletedAt;
    albumDeleted.set(media.albumId, deleted);
  }
  if (!deleted) return null;
  return startDeletingMedia(ctx, media.albumId, media.mediaId, now);
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
