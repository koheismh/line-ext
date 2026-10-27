// アップロードのユースケース（app層）。requirements 要件4 に準拠。
//  - 単一PUT: Content-Length/Type を署名に含めた署名URL + mediaId
//  - マルチパート: Create → パート署名URL群 → (再発行) → Complete(ListParts検証)
//  - メディア正本(status=uploading)と media-locator を作成

import {
  ulid,
  MULTIPART_MIN_PART_BYTES,
  UPLOAD_URL_TTL_SECONDS,
  type Media,
  type MultipartInit,
} from '@photo-album/shared';
import {
  putJsonIfAbsent,
  putJsonIfMatch,
  getJsonOrThrow,
  metaKeys,
  mediaKeys,
  getUploadSignedUrl,
  createMultipartUpload,
  getPartUploadUrls,
  completeMultipartUpload,
  listUploadedParts,
  ConflictError,
} from '../repo/index.js';
import { createMediaLocator, resolveMediaLocator } from '../repo/locator.js';
import { validateText, validateUploadDeclaration } from '../domain/validation.js';
import { canTransition } from '../domain/mediaState.js';
import type { AppContext } from './context.js';
import { AppError } from './errors.js';
import { authorizeUpload } from './authorize.js';

const MAX_RETRY = 5;
/** 表示用ファイル名の最大長（暫定）。 */
const DISPLAY_FILE_NAME_MAX_LENGTH = 255;

function extFromMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'video/mp4':
      return 'mp4';
    case 'video/quicktime':
      return 'mov';
    default:
      return 'bin';
  }
}

export interface InitUploadParams {
  albumId: string;
  userId: string;
  declaredMimeType: string;
  declaredByteSize: number;
  displayFileName: string;
  fileLastModified?: string | null;
  now: string;
}

/** 申告値を検証し、メディア種別を返す。 */
function validateInit(p: InitUploadParams): 'photo' | 'video' {
  const v = validateUploadDeclaration({
    declaredMimeType: p.declaredMimeType,
    declaredByteSize: p.declaredByteSize,
  });
  if (!v.ok) throw mapValidation(v.code, v.message);
  const name = validateText(p.displayFileName, {
    label: 'ファイル名',
    max: DISPLAY_FILE_NAME_MAX_LENGTH,
  });
  if (!name.ok) throw new AppError(422, 'invalid_file_name', name.message);
  if (
    p.fileLastModified !== undefined &&
    p.fileLastModified !== null &&
    (typeof p.fileLastModified !== 'string' || Number.isNaN(Date.parse(p.fileLastModified)))
  ) {
    throw new AppError(422, 'invalid_last_modified', 'ファイルの更新日時が不正です。');
  }
  return v.kind;
}

/**
 * 単一PUTアップロードを開始する。
 * @returns mediaId と 署名付きPUT URL
 */
export async function initSingleUpload(
  ctx: AppContext,
  p: InitUploadParams,
): Promise<{ mediaId: string; uploadUrl: string }> {
  const access = await authorizeUpload(ctx, p.albumId, p.userId);
  const kind = validateInit(p);

  const mediaId = ulid();
  const ext = extFromMime(p.declaredMimeType);
  const media: Media = buildPendingMedia(mediaId, p, kind, ext);
  await putJsonIfAbsent(ctx.metaBucket, metaKeys.media(p.albumId, mediaId), media);
  await createMediaLocator(ctx.metaBucket, mediaId, {
    albumId: p.albumId,
    ownerType: access.album.value.ownerType,
    ownerId: access.album.value.ownerId,
  });

  const uploadUrl = await getUploadSignedUrl({
    bucket: ctx.mediaBucket,
    key: mediaKeys.original(p.albumId, mediaId, ext),
    contentType: p.declaredMimeType,
    contentLength: p.declaredByteSize,
    expiresIn: UPLOAD_URL_TTL_SECONDS.single, // 参照用(5分)とは別管理（要件4-15）
  });
  return { mediaId, uploadUrl };
}

/**
 * マルチパートアップロードを開始する。
 * @param partCount 分割数（クライアントが算出）。申告サイズと S3 の最小パートサイズから上限を検証する。
 */
export async function initMultipartUpload(
  ctx: AppContext,
  p: InitUploadParams & { partCount: number },
): Promise<MultipartInit> {
  const access = await authorizeUpload(ctx, p.albumId, p.userId);
  const kind = validateInit(p);
  const maxParts = Math.min(10000, Math.ceil(p.declaredByteSize / MULTIPART_MIN_PART_BYTES));
  if (!Number.isInteger(p.partCount) || p.partCount < 1 || p.partCount > maxParts) {
    throw new AppError(422, 'invalid_part_count', 'パート数が不正です。');
  }

  const mediaId = ulid();
  const ext = extFromMime(p.declaredMimeType);
  const key = mediaKeys.original(p.albumId, mediaId, ext);

  const uploadId = await createMultipartUpload({
    bucket: ctx.mediaBucket,
    key,
    contentType: p.declaredMimeType,
  });

  const media: Media = { ...buildPendingMedia(mediaId, p, kind, ext), uploadId };
  await putJsonIfAbsent(ctx.metaBucket, metaKeys.media(p.albumId, mediaId), media);
  await createMediaLocator(ctx.metaBucket, mediaId, {
    albumId: p.albumId,
    ownerType: access.album.value.ownerType,
    ownerId: access.album.value.ownerId,
  });

  const partNumbers = Array.from({ length: p.partCount }, (_, i) => i + 1);
  const partUrls = await getPartUploadUrls({
    bucket: ctx.mediaBucket,
    key,
    uploadId,
    partNumbers,
    expiresIn: UPLOAD_URL_TTL_SECONDS.part,
  });
  return { mediaId, uploadId, partUrls };
}

/** パート署名URLを再発行する（期限切れ対策）。アップロード中のメディアのみ。 */
export async function reissuePartUrls(
  ctx: AppContext,
  p: { mediaId: string; uploadId: string; userId: string; partNumbers: number[] },
): Promise<{ partNumber: number; url: string }[]> {
  const media = await loadOwnedUploadingMedia(ctx, p.mediaId, p.uploadId, p.userId);
  if (media.status !== 'uploading') {
    throw new AppError(409, 'not_uploading', 'このアップロードは既に終了しています。');
  }
  if (
    !Array.isArray(p.partNumbers) ||
    p.partNumbers.length === 0 ||
    p.partNumbers.length > 10000 ||
    !p.partNumbers.every((n) => Number.isInteger(n) && n >= 1 && n <= 10000)
  ) {
    throw new AppError(422, 'invalid_part_numbers', 'パート番号が不正です。');
  }
  const key = mediaKeys.original(media.albumId, media.mediaId, media.originalExt);
  return getPartUploadUrls({
    bucket: ctx.mediaBucket,
    key,
    uploadId: p.uploadId,
    partNumbers: p.partNumbers,
    expiresIn: UPLOAD_URL_TTL_SECONDS.part,
  });
}

/**
 * マルチパートを完了する（冪等）。
 * サーバが ListParts で各パートの ETag とサイズを取得し、合計サイズが申告と一致することを検証してから
 * CompleteMultipartUpload する（クライアント申告の ETag は使わない）。
 * 完了後は status=validating に進める（実検証はS3イベントのサムネイルLambdaが行う）。
 */
export async function completeUpload(
  ctx: AppContext,
  p: {
    mediaId: string;
    uploadId: string;
    userId: string;
    now: string;
  },
): Promise<void> {
  const media = await loadOwnedUploadingMedia(ctx, p.mediaId, p.uploadId, p.userId);
  // 既に完了・進行済み（二重実行）なら冪等に成功扱い
  if (media.status !== 'uploading') return;

  const key = mediaKeys.original(media.albumId, media.mediaId, media.originalExt);
  const parts = await listUploadedParts(ctx.mediaBucket, key, p.uploadId);
  const total = parts.reduce((sum, part) => sum + part.size, 0);
  if (total > media.declaredByteSize) {
    throw new AppError(413, 'too_large', 'アップロードサイズが申告を超えています。');
  }
  if (parts.length === 0 || total !== media.declaredByteSize) {
    throw new AppError(422, 'size_mismatch', 'アップロードが完了していないか、サイズが申告と一致しません。');
  }

  await completeMultipartUpload({
    bucket: ctx.mediaBucket,
    key,
    uploadId: p.uploadId,
    parts: parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
  });

  // S3イベント処理が先に状態を進めている場合があるため、uploading のときだけ進める（単調性）
  await advanceToValidating(ctx, media.albumId, media.mediaId, p.now);
}

/** uploading → validating を ETag 条件付きで行う。競合時は読み直し、既に進んでいれば何もしない。 */
async function advanceToValidating(
  ctx: AppContext,
  albumId: string,
  mediaId: string,
  now: string,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const rec = await getJsonOrThrow<Media>(ctx.metaBucket, metaKeys.media(albumId, mediaId));
    if (rec.value.status !== 'uploading' || !canTransition(rec.value.status, 'validating')) return;
    try {
      await putJsonIfMatch(
        ctx.metaBucket,
        metaKeys.media(albumId, mediaId),
        { ...rec.value, status: 'validating', updatedAt: now },
        rec.etag,
      );
      return;
    } catch (err) {
      if (err instanceof ConflictError && attempt < MAX_RETRY - 1) continue;
      throw err;
    }
  }
}

// ---- helpers ----

function buildPendingMedia(
  mediaId: string,
  p: InitUploadParams,
  kind: 'photo' | 'video',
  ext: string,
): Media {
  return {
    mediaId,
    albumId: p.albumId,
    kind,
    status: 'uploading',
    errorReason: null,
    originalExt: ext,
    displayFileName: p.displayFileName,
    declaredByteSize: p.declaredByteSize,
    declaredMimeType: p.declaredMimeType,
    byteSize: null,
    mimeType: null,
    videoCodec: null,
    capturedAt: null,
    fileLastModified: p.fileLastModified ?? null,
    uploadId: null,
    createdBy: p.userId,
    createdAt: p.now,
    updatedAt: p.now,
  };
}

function mapValidation(code: string, message: string): AppError {
  if (code === 'unsupported_type') return new AppError(415, code, message);
  if (code === 'too_large') return new AppError(413, code, message);
  return new AppError(422, code, message);
}

async function loadOwnedUploadingMedia(
  ctx: AppContext,
  mediaId: string,
  uploadId: string,
  userId: string,
): Promise<Media> {
  const loc = await resolveMediaLocator(ctx.metaBucket, mediaId);
  if (!loc) throw new AppError(404, 'not_found', 'メディアが見つかりません。');
  await authorizeUpload(ctx, loc.albumId, userId);
  const rec = await getJsonOrThrow<Media>(ctx.metaBucket, metaKeys.media(loc.albumId, mediaId));
  // アップロードの継続・完了は開始した本人のみ
  if (rec.value.createdBy !== userId) {
    throw new AppError(403, 'forbidden', 'このアップロードを操作する権限がありません。');
  }
  if (rec.value.uploadId !== uploadId) {
    throw new AppError(409, 'upload_mismatch', 'アップロードIDが一致しません。');
  }
  return rec.value;
}
