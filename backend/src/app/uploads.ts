// アップロードのユースケース（app層）。requirements 要件4 に準拠。
//  - 単一PUT: Content-Length/Type を署名に含めた署名URL + mediaId
//  - マルチパート: Create → パート署名URL群 → (再発行) → Complete(ListParts検証)
//  - メディア正本(status=uploading)と media-locator を作成

import {
  ulid,
  SIGNED_URL_TTL_SECONDS,
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
  sumUploadedParts,
} from '../repo/index.js';
import { createMediaLocator, resolveMediaLocator } from '../repo/locator.js';
import { validateUploadDeclaration } from '../domain/validation.js';
import { canTransition } from '../domain/mediaState.js';
import type { AppContext } from './context.js';
import { AppError } from './errors.js';
import { authorizeUpload } from './authorize.js';

/** アップロード署名URLの有効期限（秒）。分割完了に足る長さ。暫定1時間。 */
const UPLOAD_URL_TTL = 60 * 60;

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

/**
 * 単一PUTアップロードを開始する。
 * @returns mediaId と 署名付きPUT URL
 */
export async function initSingleUpload(
  ctx: AppContext,
  p: InitUploadParams,
): Promise<{ mediaId: string; uploadUrl: string }> {
  const access = await authorizeUpload(ctx, p.albumId, p.userId);
  const v = validateUploadDeclaration({
    declaredMimeType: p.declaredMimeType,
    declaredByteSize: p.declaredByteSize,
  });
  if (!v.ok) throw mapValidation(v.code, v.message);

  const mediaId = ulid();
  const ext = extFromMime(p.declaredMimeType);
  const media: Media = buildPendingMedia(mediaId, p, v.kind, ext);
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
    expiresIn: SIGNED_URL_TTL_SECONDS.original, // 単一PUTは短めで十分
  });
  return { mediaId, uploadUrl };
}

/**
 * マルチパートアップロードを開始する。
 * @param partCount 分割数（クライアントが算出）
 */
export async function initMultipartUpload(
  ctx: AppContext,
  p: InitUploadParams & { partCount: number },
): Promise<MultipartInit> {
  const access = await authorizeUpload(ctx, p.albumId, p.userId);
  const v = validateUploadDeclaration({
    declaredMimeType: p.declaredMimeType,
    declaredByteSize: p.declaredByteSize,
  });
  if (!v.ok) throw mapValidation(v.code, v.message);
  if (p.partCount < 1 || p.partCount > 10000) {
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

  const media: Media = { ...buildPendingMedia(mediaId, p, v.kind, ext), uploadId };
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
    expiresIn: UPLOAD_URL_TTL,
  });
  return { mediaId, uploadId, partUrls };
}

/** パート署名URLを再発行する（期限切れ対策）。 */
export async function reissuePartUrls(
  ctx: AppContext,
  p: { mediaId: string; uploadId: string; userId: string; partNumbers: number[] },
): Promise<{ partNumber: number; url: string }[]> {
  const media = await loadOwnedUploadingMedia(ctx, p.mediaId, p.uploadId, p.userId);
  const key = mediaKeys.original(media.albumId, media.mediaId, media.originalExt);
  return getPartUploadUrls({
    bucket: ctx.mediaBucket,
    key,
    uploadId: p.uploadId,
    partNumbers: p.partNumbers,
    expiresIn: UPLOAD_URL_TTL,
  });
}

/**
 * マルチパートを完了する。
 * ListParts で合計サイズを検証し、申告超過・上限超過を拒否してから Complete。
 * 完了後は status=validating に進める（実検証はS3イベントのサムネイルLambdaが行う）。
 */
export async function completeUpload(
  ctx: AppContext,
  p: {
    mediaId: string;
    uploadId: string;
    userId: string;
    parts: { partNumber: number; etag: string }[];
    now: string;
  },
): Promise<void> {
  const loc = await resolveMediaLocatorOrThrow(ctx, p.mediaId);
  await authorizeUpload(ctx, loc.albumId, p.userId);
  const mediaRec = await getJsonOrThrow<Media>(
    ctx.metaBucket,
    metaKeys.media(loc.albumId, p.mediaId),
  );
  const media = mediaRec.value;
  if (media.uploadId !== p.uploadId) {
    throw new AppError(409, 'upload_mismatch', 'アップロードIDが一致しません。');
  }

  const key = mediaKeys.original(media.albumId, media.mediaId, media.originalExt);
  const total = await sumUploadedParts(ctx.mediaBucket, key, p.uploadId);
  if (total > media.declaredByteSize) {
    throw new AppError(413, 'too_large', 'アップロードサイズが申告を超えています。');
  }

  await completeMultipartUpload({
    bucket: ctx.mediaBucket,
    key,
    uploadId: p.uploadId,
    parts: p.parts,
  });

  if (!canTransition(media.status, 'validating')) {
    // 既に進んでいる等。冪等に成功扱い
    return;
  }
  const updated: Media = { ...media, status: 'validating', updatedAt: p.now };
  await putJsonIfMatch(
    ctx.metaBucket,
    metaKeys.media(media.albumId, p.mediaId),
    updated,
    mediaRec.etag,
  );
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

async function resolveMediaLocatorOrThrow(
  ctx: AppContext,
  mediaId: string,
): Promise<{ albumId: string }> {
  const loc = await resolveMediaLocator(ctx.metaBucket, mediaId);
  if (!loc) throw new AppError(404, 'not_found', 'メディアが見つかりません。');
  return loc;
}

async function loadOwnedUploadingMedia(
  ctx: AppContext,
  mediaId: string,
  uploadId: string,
  userId: string,
): Promise<Media> {
  const loc = await resolveMediaLocatorOrThrow(ctx, mediaId);
  await authorizeUpload(ctx, loc.albumId, userId);
  const rec = await getJsonOrThrow<Media>(ctx.metaBucket, metaKeys.media(loc.albumId, mediaId));
  if (rec.value.uploadId !== uploadId) {
    throw new AppError(409, 'upload_mismatch', 'アップロードIDが一致しません。');
  }
  return rec.value;
}
