// メディア参照のユースケース（app層）。requirements 要件5 に準拠。
//  - listAlbumMedia: 閲覧認可 → ready のみ（投稿者本人には処理中/失敗も）→ プレビューURL同梱 → 登録日時昇順 → ページング
//  - getMediaUrl: 閲覧認可 → 状態チェック（ready のみ、deleting以降除外）→ 用途別署名URL
//  - trash/ は参照対象にしない

import {
  isSignedUrlKind,
  type Media,
  type SignedUrlKind,
  type MediaListItem,
  type MediaPage,
} from '@photo-album/shared';
import {
  getJson,
  listKeys,
  metaKeys,
  mediaKeys,
  getReadSignedUrl,
} from '../repo/index.js';
import { isPubliclyVisible, canIssueMediaUrl } from '../domain/mediaState.js';
import type { AppContext } from './context.js';
import { AppError, notFoundOrForbidden } from './errors.js';
import { authorizeAlbumView, authorizeMediaView } from './authorize.js';

const DEFAULT_PAGE_SIZE = 60;

export type { MediaPage };

/**
 * アルバムのメディア一覧。
 * ready のみ表示（投稿者本人には uploading/validating/error も表示）。
 * ULIDキーにより ListObjects は登録日時昇順。プレビューURLを同梱。
 */
export async function listAlbumMedia(
  ctx: AppContext,
  albumId: string,
  userId: string,
  opts?: { pageSize?: number; pageToken?: string },
): Promise<MediaPage> {
  await authorizeAlbumView(ctx, albumId, userId);

  const page = await listKeys(ctx.metaBucket, metaKeys.mediaPrefix(albumId), {
    maxKeys: opts?.pageSize ?? DEFAULT_PAGE_SIZE,
    ...(opts?.pageToken ? { continuationToken: opts.pageToken } : {}),
  });

  const items: MediaListItem[] = [];
  for (const key of page.keys) {
    const rec = await getJson<Media>(ctx.metaBucket, key);
    if (!rec) continue;
    const media = rec.value;
    const visible = isPubliclyVisible(media.status) || isOwnerSideVisible(media, userId);
    if (!visible) continue;

    const previewUrl =
      media.status === 'ready'
        ? await getReadSignedUrl({
            bucket: ctx.mediaBucket,
            key: mediaKeys.preview(media.albumId, media.mediaId),
            kind: 'preview',
          })
        : null;

    items.push({
      mediaId: media.mediaId,
      albumId: media.albumId,
      kind: media.kind,
      status: media.status,
      errorReason: media.status === 'error' ? media.errorReason : null,
      previewUrl,
      displayFileName: media.displayFileName,
      videoCodec: media.videoCodec,
      createdBy: media.createdBy,
      createdAt: media.createdAt,
    });
  }

  return { items, ...(page.nextToken ? { nextToken: page.nextToken } : {}) };
}

/** 投稿者本人に対して、処理中/失敗を表示してよいか。 */
function isOwnerSideVisible(media: Media, userId: string): boolean {
  if (media.createdBy !== userId) return false;
  return (
    media.status === 'uploading' ||
    media.status === 'validating' ||
    media.status === 'error'
  );
}

/**
 * メディアの署名付きURLを発行する。
 * - 権限確認後、ready のみ。deleting 以降・trash/ は対象外。
 * - kind 別に期限が異なる（preview/original/video/download）。
 * - original/download は検証済みMIMEで ResponseContentType を上書き。
 */
export async function getMediaUrl(
  ctx: AppContext,
  mediaId: string,
  userId: string,
  kind: SignedUrlKind,
): Promise<string> {
  if (!isSignedUrlKind(kind)) {
    throw new AppError(422, 'invalid_kind', 'kind は preview / original / video / download のいずれかです。');
  }
  const access = await authorizeMediaView(ctx, mediaId, userId);
  const media = access.media.value;

  if (!canIssueMediaUrl(media.status)) {
    // ready 以外（deleting以降含む）はURLを発行しない
    throw notFoundOrForbidden('このメディアは利用できません。');
  }

  if (kind === 'preview') {
    return getReadSignedUrl({
      bucket: ctx.mediaBucket,
      key: mediaKeys.preview(media.albumId, media.mediaId),
      kind,
    });
  }

  // original / video / download は原本を対象にする
  const originalKey = mediaKeys.original(media.albumId, media.mediaId, media.originalExt);
  // kind=video は動画のみ許可
  if (kind === 'video' && media.kind !== 'video') {
    throw new AppError(422, 'not_a_video', 'このメディアは動画ではありません。');
  }
  return getReadSignedUrl({
    bucket: ctx.mediaBucket,
    key: originalKey,
    kind,
    ...(media.mimeType ? { contentType: media.mimeType } : {}),
    ...(kind === 'download' ? { downloadFileName: media.displayFileName } : {}),
  });
}
