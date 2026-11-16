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

/** グループの正本。削除済み（deletedAt あり）は存在しないものとして null を返す。 */
export async function getGroup(
  ctx: AppContext,
  groupId: string,
): Promise<JsonRecord<Group> | null> {
  const rec = await getGroupIncludingDeleted(ctx, groupId);
  if (!rec || rec.value.deletedAt) return null;
  return rec;
}

/** 削除済みも含めてグループの正本を読む（削除の二重実行の判定など、限られた用途のみ）。 */
export async function getGroupIncludingDeleted(
  ctx: AppContext,
  groupId: string,
): Promise<JsonRecord<Group> | null> {
  return getJson<Group>(ctx.metaBucket, metaKeys.group(groupId));
}

/** アルバムの正本（locator 経由）。削除済み（deletedAt あり）は存在しないものとして null を返す。 */
export async function getAlbumByLocator(
  ctx: AppContext,
  albumId: string,
): Promise<JsonRecord<Album> | null> {
  const rec = await getAlbumIncludingDeleted(ctx, albumId);
  if (!rec || rec.value.deletedAt) return null;
  return rec;
}

/** 削除済みも含めてアルバムの正本を読む（削除の二重実行・残ったメディアの片付けなど、限られた用途のみ）。 */
export async function getAlbumIncludingDeleted(
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
