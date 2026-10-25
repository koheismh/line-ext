// 正本エンティティの型付き取得（app層）。
// repo の jsonStore + keys をラップし、ETag付きで返す。

import type { Album, Group, Media, Comment } from '@photo-album/shared';
import { getJson, metaKeys, type JsonRecord } from '../repo/index.js';
import type { AppContext } from './context.js';
import {
  resolveAlbumLocator,
  resolveMediaLocator,
  resolveCommentLocator,
} from '../repo/locator.js';

export async function getGroup(
  ctx: AppContext,
  groupId: string,
): Promise<JsonRecord<Group> | null> {
  return getJson<Group>(ctx.metaBucket, metaKeys.group(groupId));
}

export async function getAlbumByLocator(
  ctx: AppContext,
  albumId: string,
): Promise<JsonRecord<Album> | null> {
  const loc = await resolveAlbumLocator(ctx.metaBucket, albumId);
  if (!loc) return null;
  return getJson<Album>(ctx.metaBucket, metaKeys.album(loc.ownerType, loc.ownerId, albumId));
}

export async function getMediaByLocator(
  ctx: AppContext,
  mediaId: string,
): Promise<JsonRecord<Media> | null> {
  const loc = await resolveMediaLocator(ctx.metaBucket, mediaId);
  if (!loc) return null;
  return getJson<Media>(ctx.metaBucket, metaKeys.media(loc.albumId, mediaId));
}

export async function getCommentByLocator(
  ctx: AppContext,
  commentId: string,
): Promise<JsonRecord<Comment> | null> {
  const loc = await resolveCommentLocator(ctx.metaBucket, commentId);
  if (!loc) return null;
  return getJson<Comment>(
    ctx.metaBucket,
    metaKeys.comment(loc.targetType, loc.targetId, loc.rootCommentId, commentId),
  );
}
