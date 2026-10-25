// 認可の解決（app層）。locator→正本取得→ドメインの権限判定を束ねる。
// 方針:
//  - 閲覧権限がない/存在しない → 404（notFoundOrForbidden）で存在を隠す
//  - 閲覧はできるが操作不可 → 403（forbidden）
//  - 認可は常に取得した正本（Album/Group/Media）に基づく（クライアント申告値を信用しない）

import type { Album, Group, Media } from '@photo-album/shared';
import {
  canViewAlbum,
  canEditAlbum,
  canUploadMedia,
  canDeleteMedia,
  canPostComment,
} from '../domain/authz.js';
import type { AppContext } from './context.js';
import { notFoundOrForbidden, forbidden } from './errors.js';
import { getAlbumByLocator, getMediaByLocator, getGroup } from './entities.js';
import type { JsonRecord } from '../repo/index.js';

/** アルバムの所有グループ（group所有時のみ）を取得する。 */
async function loadOwnerGroup(ctx: AppContext, album: Album): Promise<Group | null> {
  if (album.ownerType !== 'group') return null;
  const rec = await getGroup(ctx, album.ownerId);
  return rec?.value ?? null;
}

export interface AlbumAccess {
  album: JsonRecord<Album>;
  group: Group | null;
}

/**
 * アルバムの閲覧権限を解決する。
 * 権限がない/存在しない場合は 404 を投げる（存在を隠す）。
 */
export async function authorizeAlbumView(
  ctx: AppContext,
  albumId: string,
  userId: string,
): Promise<AlbumAccess> {
  const rec = await getAlbumByLocator(ctx, albumId);
  if (!rec) throw notFoundOrForbidden();
  const group = await loadOwnerGroup(ctx, rec.value);
  if (!canViewAlbum(rec.value, userId, group)) {
    throw notFoundOrForbidden();
  }
  return { album: rec, group };
}

/**
 * アルバム編集（タイトル/説明/表紙）の権限を解決する。
 * 閲覧不可は404、閲覧可だが作成者でないなら403。
 */
export async function authorizeAlbumEdit(
  ctx: AppContext,
  albumId: string,
  userId: string,
): Promise<AlbumAccess> {
  const access = await authorizeAlbumView(ctx, albumId, userId);
  if (!canEditAlbum(access.album.value, userId)) {
    throw forbidden('アルバムを編集できるのは作成者のみです。');
  }
  return access;
}

/** メディアアップロードの権限を解決する（閲覧権限と同じ＝所有者/メンバー）。 */
export async function authorizeUpload(
  ctx: AppContext,
  albumId: string,
  userId: string,
): Promise<AlbumAccess> {
  const access = await authorizeAlbumView(ctx, albumId, userId);
  if (!canUploadMedia(access.album.value, userId, access.group)) {
    throw forbidden('このアルバムにアップロードする権限がありません。');
  }
  return access;
}

export interface MediaAccess {
  media: JsonRecord<Media>;
  album: Album;
  group: Group | null;
}

/**
 * メディアの閲覧権限を解決する（親アルバムの閲覧権限で判定）。
 * 権限がない/存在しない場合は 404。
 */
export async function authorizeMediaView(
  ctx: AppContext,
  mediaId: string,
  userId: string,
): Promise<MediaAccess> {
  const mediaRec = await getMediaByLocator(ctx, mediaId);
  if (!mediaRec) throw notFoundOrForbidden();
  const access = await authorizeAlbumView(ctx, mediaRec.value.albumId, userId);
  return { media: mediaRec, album: access.album.value, group: access.group };
}

/**
 * メディア削除の権限を解決する。
 * 閲覧不可は404、閲覧可だが削除権限なしは403。
 */
export async function authorizeMediaDelete(
  ctx: AppContext,
  mediaId: string,
  userId: string,
): Promise<MediaAccess> {
  const access = await authorizeMediaView(ctx, mediaId, userId);
  if (!canDeleteMedia(access.album, access.media.value, userId, access.group)) {
    throw forbidden('このメディアを削除する権限がありません。');
  }
  return access;
}

/** コメント投稿の権限を解決する（対象アルバムの閲覧権限）。 */
export async function authorizeCommentPost(
  ctx: AppContext,
  albumId: string,
  userId: string,
): Promise<AlbumAccess> {
  const access = await authorizeAlbumView(ctx, albumId, userId);
  if (!canPostComment(access.album.value, userId, access.group)) {
    throw forbidden('コメントを投稿する権限がありません。');
  }
  return access;
}
