// メディア検証・プレビュー生成のユースケース（app層）。requirements 要件4-7/4-8/5-1/5-4 準拠。
// 実バイナリ処理（Sharp/FFmpeg・S3 Range取得）は MediaProcessor インターフェースに隔離し、
// ここでは状態遷移の冪等性・単調性のみを扱う（テスト可能にする）。

import { type Media, type MediaErrorReason } from '@photo-album/shared';
import { getJsonOrThrow, putJsonIfMatch, metaKeys, ConflictError } from '../repo/index.js';
import { shouldSkipProcessing, canTransition } from '../domain/mediaState.js';
import type { AppContext } from './context.js';

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

/**
 * S3 ObjectCreated（originals/）起点の処理。冪等・単調。
 * 1. 現在状態を確認し skip 対象なら何もしない
 * 2. 実検証 → 失敗なら error(invalid_file)
 * 3. プレビュー生成 → 失敗なら error(preview_failed)
 * 4. ready（書き込み前後で状態再確認し、削除済みなら ready に戻さない）
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
  if (media.status === 'ready') return; // 既に処理済み
  // uploading から来た場合も validating 相当として処理（S3到着＝アップロード完了）

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
  } catch {
    await setError(ctx, albumId, mediaId, 'preview_failed');
    return;
  }

  // 3) ready へ（書き込み時に状態を再確認：削除済みなら戻さない）
  await setReady(ctx, albumId, mediaId);
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

async function setReady(ctx: AppContext, albumId: string, mediaId: string): Promise<void> {
  await updateWithRetry(ctx, albumId, mediaId, (media) => {
    // 削除系に遷移していたら ready に戻さない（単調性）
    if (shouldSkipProcessing(media.status, media.errorReason)) return null;
    if (media.status === 'ready') return null;
    return { ...media, status: 'ready', errorReason: null, updatedAt: new Date().toISOString() };
  });
}

/**
 * ETag条件付きで更新する共通処理。
 * updater が null を返したら更新しない（単調性・冪等）。
 */
async function updateWithRetry(
  ctx: AppContext,
  albumId: string,
  mediaId: string,
  updater: (media: Media) => Media | null,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const rec = await getJsonOrThrow<Media>(ctx.metaBucket, metaKeys.media(albumId, mediaId));
    const next = updater(rec.value);
    if (next === null) return;
    // status を変える場合は遷移の妥当性を確認
    if (next.status !== rec.value.status && !canTransition(rec.value.status, next.status, rec.value.errorReason)) {
      return;
    }
    try {
      await putJsonIfMatch(ctx.metaBucket, metaKeys.media(albumId, mediaId), next, rec.etag);
      return;
    } catch (err) {
      if (err instanceof ConflictError && attempt < MAX_RETRY - 1) continue;
      throw err;
    }
  }
}
