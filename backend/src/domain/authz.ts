// 操作×役割の権限判定（純粋関数）。
// requirements.md 要件8 の権限表に準拠。認可は常に正本データに基づく。
//
// 重要: ここはクライアント申告値ではなく、呼び出し側が取得した正本
// （Album / Group / Media / Comment）を渡して判定する。

import type { Album, Group, Media, Comment, OwnerType } from '@photo-album/shared';

/** グループのメンバーか（正本で判定）。 */
export function isGroupMember(group: Group, userId: string): boolean {
  return group.memberUserIds.includes(userId);
}

/** グループの管理者か（正本で判定）。 */
export function isGroupAdmin(group: Group, userId: string): boolean {
  return group.adminUserIds.includes(userId);
}

/**
 * アルバムを閲覧できるか。
 * - user所有: 所有者本人
 * - group所有: グループメンバー（group は ownerId のグループ正本）
 */
export function canViewAlbum(album: Album, userId: string, group: Group | null): boolean {
  if (album.ownerType === 'user') {
    return album.ownerId === userId;
  }
  return !!group && isGroupMember(group, userId);
}

/** 所有主体に対してアルバムを作成できるか。 */
export function canCreateAlbum(
  ownerType: OwnerType,
  ownerId: string,
  userId: string,
  group: Group | null,
): boolean {
  if (ownerType === 'user') {
    return ownerId === userId;
  }
  return !!group && isGroupMember(group, userId);
}

/** アルバムを編集（タイトル/説明/表紙）できるか＝作成者のみ。 */
export function canEditAlbum(album: Album, userId: string): boolean {
  return album.createdBy === userId;
}

/** メディアをアップロードできるか＝閲覧権限と同じ（所有者/メンバー）。 */
export function canUploadMedia(album: Album, userId: string, group: Group | null): boolean {
  return canViewAlbum(album, userId, group);
}

/**
 * メディアを削除できるか。
 * - user所有: アルバム所有者本人
 * - group所有: メディア投稿者 または グループ管理者
 */
export function canDeleteMedia(
  album: Album,
  media: Media,
  userId: string,
  group: Group | null,
): boolean {
  if (album.ownerType === 'user') {
    return album.ownerId === userId;
  }
  if (media.createdBy === userId) return true;
  return !!group && isGroupAdmin(group, userId);
}

/** コメントを投稿できるか＝対象アルバムの閲覧権限者。 */
export function canPostComment(album: Album, userId: string, group: Group | null): boolean {
  return canViewAlbum(album, userId, group);
}

/**
 * コメントを削除できるか。
 * - 投稿者本人 または（group所有なら）グループ管理者
 */
export function canDeleteComment(
  album: Album,
  comment: Comment,
  userId: string,
  group: Group | null,
): boolean {
  if (comment.authorUserId === userId) return true;
  if (album.ownerType === 'group') {
    return !!group && isGroupAdmin(group, userId);
  }
  return false;
}

/** 招待の発行・失効ができるか＝グループ管理者のみ。 */
export function canManageInvite(group: Group, userId: string): boolean {
  return isGroupAdmin(group, userId);
}
