// S3キーの構築を一元化する。パス構造を上位レイヤに漏らさない（conventions）。
// structure.md のS3レイアウトに準拠。

import { createHash } from 'node:crypto';
import type { OwnerType } from '@photo-album/shared';

/** sha256 の16進ダイジェスト。招待トークンやLINE sub のハッシュ化に使う。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ---- メタデータバケットのキー ----

export const metaKeys = {
  user: (userId: string) => `users/${userId}.json`,
  lineIdentity: (lineSub: string) => `identities/line/${sha256Hex(lineSub)}.json`,
  userGroup: (userId: string, groupId: string) => `user-groups/${userId}/${groupId}.json`,
  userGroupsPrefix: (userId: string) => `user-groups/${userId}/`,
  group: (groupId: string) => `groups/${groupId}.json`,
  invite: (token: string) => `invites/${sha256Hex(token)}.json`,
  inviteByHash: (tokenHash: string) => `invites/${tokenHash}.json`,
  album: (ownerType: OwnerType, ownerId: string, albumId: string) =>
    `albums/${ownerType}/${ownerId}/${albumId}.json`,
  albumLocator: (albumId: string) => `album-locator/${albumId}.json`,
  media: (albumId: string, mediaId: string) => `media/${albumId}/${mediaId}.json`,
  mediaPrefix: (albumId: string) => `media/${albumId}/`,
  mediaLocator: (mediaId: string) => `media-locator/${mediaId}.json`,
  comment: (
    targetType: 'album' | 'media',
    targetId: string,
    rootCommentId: string,
    commentId: string,
  ) => `comments/${targetType}/${targetId}/${rootCommentId}/${commentId}.json`,
  commentTargetPrefix: (targetType: 'album' | 'media', targetId: string) =>
    `comments/${targetType}/${targetId}/`,
  commentLocator: (commentId: string) => `comment-locator/${commentId}.json`,
};

// ---- メディアバケットのキー ----

export const mediaKeys = {
  original: (albumId: string, mediaId: string, ext: string) =>
    `originals/${albumId}/${mediaId}/source.${ext}`,
  preview: (albumId: string, mediaId: string) => `previews/${albumId}/${mediaId}/thumbnail.jpg`,
  trashOriginal: (deletedDate: string, albumId: string, mediaId: string, ext: string) =>
    `trash/${deletedDate}/${albumId}/${mediaId}/source.${ext}`,
  trashPreview: (deletedDate: string, albumId: string, mediaId: string) =>
    `trash/${deletedDate}/${albumId}/${mediaId}/thumbnail.jpg`,
};
