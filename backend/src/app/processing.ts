// メディア検証・プレビュー生成のユースケース（app層）。requirements 要件4-7/4-8/5-1/5-4 準拠。
// 実バイナリ処理（Sharp/FFmpeg・S3 Range取得）は MediaProcessor インターフェースに隔離し、
// ここでは状態遷移の冪等性・単調性のみを扱う（テスト可能にする）。

import { type Media, type MediaErrorReason } from '@photo-album/shared';
import {
  getJsonOrThrow,
  putJsonIfMatch,
  metaKeys,
  mediaKeys,
  deleteObject,
  touchObject,
  ConflictError,
} from '../repo/index.js';
import { shouldSkipProcessing, canTransition } from '../domain/mediaState.js';
import type { AppContext } from './context.js';
import { AppError, forbidden } from './errors.js';
import { authorizeMediaView } from './authorize.js';
import { recalcCoverForAlbum } from './albums.js';

const MAX_RETRY = 5;

/** 実ファイル検証の結果。 */
export interface ValidationOutcome {
  ok: boolean;
  byteSize: number | null;
  mimeType: string | null;
  videoCodec: string | null;
  capturedAt: string | null;
}

/**
 * 実バイナリ処理のアダプタ。実装は Lambda 側（Sharp/FFmpeg/S3 Range）で注入する。
 * app層はこのインターフェースにのみ依存し、テストではフェイクを渡す。
 */
export interface MediaProcessor {
  /** 原本の実サイズ・MIME・コーデックを検証する。 */
  validate(media: Media): Promise<ValidationOutcome>;
  /** プレビューを生成して previews/ に保存する。失敗時は例外。 */
  generatePreview(media: Media): Promise<void>;
}

/** 削除・失効系（プレビューを残してはいけない）状態か。 */
function isRemoved(status: Media['status']): boolean {
  return status === 'deleting' || status === 'trashed' || status === 'expired';
}

/**
 * S3 ObjectCreated（originals/）起点の処理。冪等・単調。
 * 1. 現在状態を確認し skip 対象なら何もしない（ready なら表紙の再計算だけ行う）
 * 2. uploading（単一PUT到着）/ error(preview_failed)（再処理）は validating に進める
 * 3. 実検証 → 失敗なら error(invalid_file)
 * 4. プレビュー生成 → 失敗なら error(preview_failed)
 * 5. ready（書き込み時に状態再確認し、削除済みなら ready に戻さず書いたプレビューを片付ける）
 * 6. ready になったら表紙を再計算（最初の写真の自動設定, 要件3-8）
 */
export async function processUploadedMedia(
  ctx: AppContext,
  albumId: string,
  mediaId: string,
  processor: MediaProcessor,
): Promise<void> {
  const rec = await getJsonOrThrow<Media>(ctx.metaBucket, metaKeys.media(albumId, mediaId));
  const media = rec.value;

  // 冪等・単調性: 進行済み/削除系は skip
  if (shouldSkipProcessing(media.status, media.errorReason)) return;
  if (media.status === 'ready') {
    // 重複イベント・前回の表紙更新失敗からの再試行（表紙の再計算は冪等）
    await recalcCoverForAlbum(ctx, albumId);
    return;
  }

  // S3到着＝アップロード完了（uploading）、または再処理（error(preview_failed)）なら validating へ進める
  // （状態機械は uploading→validating→ready。直接 ready には遷移できない）
  if (media.status === 'uploading' || media.status === 'error') {
    const moved = await transitionTo(ctx, albumId, mediaId, 'validating');
    if (moved.status !== 'validating') return; // 並行して削除等に進んだ
  }

  // 1) 実検証
  const outcome = await processor.validate(media);
  if (!outcome.ok) {
    await setError(ctx, albumId, mediaId, 'invalid_file');
    return;
  }

  // 検証結果を反映（まだ ready にしない）
  await applyValidation(ctx, albumId, mediaId, outcome);

  // 2) プレビュー生成
  try {
    await processor.generatePreview(media);
  } catch (err) {
    console.warn('[processing] プレビュー生成に失敗しました', {
      mediaId,
      message: (err as Error).message,
    });
    await setError(ctx, albumId, mediaId, 'preview_failed');
    return;
  }

  // 3) ready へ（書き込み時に状態を再確認：削除済みなら戻さない）
  const after = await setReady(ctx, albumId, mediaId);
  if (after.status === 'ready') {
    await recalcCoverForAlbum(ctx, albumId);
  } else if (isRemoved(after.status)) {
    // 生成中に削除・失効された: 書いたプレビューが previews/ に残らないよう片付ける（design: 書き込み前後で状態再確認）
    await deleteObject(ctx.mediaBucket, mediaKeys.preview(albumId, mediaId));
  }
}

/**
 * プレビュー生成に失敗したメディアの再処理を要求する（要件5-4。投稿者のみ）。
 * 原本を同じキーへ上書きコピーして ObjectCreated を再発火させ、サムネイルLambdaに処理させる。
 */
export async function requestReprocess(
  ctx: AppContext,
  mediaId: string,
  userId: string,
): Promise<void> {
  const access = await authorizeMediaView(ctx, mediaId, userId);
  const media = access.media.value;
  if (media.createdBy !== userId) {
    throw forbidden('再処理できるのは投稿者のみです。');
  }
  if (media.status !== 'error' || media.errorReason !== 'preview_failed') {
    throw new AppError(409, 'not_reprocessable', 'このメディアは再処理できません。');
  }
  await touchObject(
    ctx.mediaBucket,
    mediaKeys.original(media.albumId, media.mediaId, media.originalExt),
    media.mimeType ?? media.declaredMimeType,
  );
}

async function applyValidation(
  ctx: AppContext,
  albumId: string,
  mediaId: string,
  outcome: ValidationOutcome,
): Promise<void> {
  await updateWithRetry(ctx, albumId, mediaId, (media) => {
    if (shouldSkipProcessing(media.status, media.errorReason) || media.status === 'ready') {
      return null; // 変更しない
    }
    return {
      ...media,
      byteSize: outcome.byteSize,
      mimeType: outcome.mimeType,
      videoCodec: outcome.videoCodec,
      capturedAt: outcome.capturedAt,
      updatedAt: new Date().toISOString(),
    };
  });
}

async function setError(
  ctx: AppContext,
  albumId: string,
  mediaId: string,
  reason: MediaErrorReason,
): Promise<void> {
  await updateWithRetry(ctx, albumId, mediaId, (media) => {
    if (shouldSkipProcessing(media.status, media.errorReason)) return null;
    return {
      ...media,
      status: 'error',
      errorReason: reason,
      updatedAt: new Date().toISOString(),
    };
  });
}

/** 指定状態へ遷移する（許可された遷移のみ。skip対象なら何もしない）。遷移後（または現在）の値を返す。 */
async function transitionTo(
  ctx: AppContext,
  albumId: string,
  mediaId: string,
  to: Media['status'],
): Promise<Media> {
  return updateWithRetry(ctx, albumId, mediaId, (media) => {
    if (shouldSkipProcessing(media.status, media.errorReason)) return null;
    if (media.status === to) return null;
    // errorReason は error のときだけ持つ
    return { ...media, status: to, errorReason: null, updatedAt: new Date().toISOString() };
  });
}

async function setReady(ctx: AppContext, albumId: string, mediaId: string): Promise<Media> {
  return updateWithRetry(ctx, albumId, mediaId, (media) => {
    // 削除系に遷移していたら ready に戻さない（単調性）
    if (shouldSkipProcessing(media.status, media.errorReason)) return null;
    if (media.status === 'ready') return null;
    return { ...media, status: 'ready', errorReason: null, updatedAt: new Date().toISOString() };
  });
}

/**
 * ETag条件付きで更新する共通処理。
 * updater が null を返したら更新しない（単調性・冪等）。
 * @returns 更新後の値（更新しなかった場合は最新の現在値）
 */
async function updateWithRetry(
  ctx: AppContext,
  albumId: string,
  mediaId: string,
  updater: (media: Media) => Media | null,
): Promise<Media> {
  for (let attempt = 0; ; attempt++) {
    const rec = await getJsonOrThrow<Media>(ctx.metaBucket, metaKeys.media(albumId, mediaId));
    const next = updater(rec.value);
    if (next === null) return rec.value;
    // status を変える場合は遷移の妥当性を確認
    if (
      next.status !== rec.value.status &&
      !canTransition(rec.value.status, next.status, rec.value.errorReason)
    ) {
      return rec.value;
    }
    try {
      await putJsonIfMatch(ctx.metaBucket, metaKeys.media(albumId, mediaId), next, rec.etag);
      return next;
    } catch (err) {
      if (err instanceof ConflictError && attempt < MAX_RETRY - 1) continue;
      throw err;
    }
  }
}
