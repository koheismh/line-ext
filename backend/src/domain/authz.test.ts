import { describe, it, expect } from 'vitest';
import {
  canViewAlbum,
  canCreateAlbum,
  canEditAlbum,
  canUploadMedia,
  canDeleteMedia,
  canPostComment,
  canDeleteComment,
  canManageInvite,
  isGroupMember,
  isGroupAdmin,
} from './authz.js';
import type { Album, Group, Media, Comment } from '@photo-album/shared';

const base = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

const group: Group = {
  groupId: 'g1',
  name: 'family',
  adminUserIds: ['admin'],
  memberUserIds: ['admin', 'member'],
  createdBy: 'admin',
  ...base,
};

const userAlbum: Album = {
  albumId: 'a-user',
  ownerType: 'user',
  ownerId: 'owner',
  title: 't',
  description: '',
  coverMediaId: null,
  coverSource: 'auto',
  createdBy: 'owner',
  ...base,
};

const groupAlbum: Album = {
  albumId: 'a-group',
  ownerType: 'group',
  ownerId: 'g1',
  title: 't',
  description: '',
  coverMediaId: null,
  coverSource: 'auto',
  createdBy: 'member',
  ...base,
};

function media(createdBy: string): Media {
  return {
    mediaId: 'm1',
    albumId: 'a-group',
    kind: 'photo',
    status: 'ready',
    errorReason: null,
    originalExt: 'jpg',
    displayFileName: 'a.jpg',
    declaredByteSize: 100,
    declaredMimeType: 'image/jpeg',
    byteSize: 100,
    mimeType: 'image/jpeg',
    videoCodec: null,
    capturedAt: null,
    fileLastModified: null,
    uploadId: null,
    createdBy,
    ...base,
  };
}

function comment(authorUserId: string): Comment {
  return {
    commentId: 'c1',
    targetType: 'media',
    targetId: 'm1',
    rootCommentId: 'c1',
    replyToCommentId: null,
    body: 'x',
    status: 'active',
    authorUserId,
    createdAt: '2026-01-01T00:00:00Z',
    deletedAt: null,
  };
}

describe('グループ判定', () => {
  it('メンバー/管理者を正本で判定', () => {
    expect(isGroupMember(group, 'member')).toBe(true);
    expect(isGroupMember(group, 'stranger')).toBe(false);
    expect(isGroupAdmin(group, 'admin')).toBe(true);
    expect(isGroupAdmin(group, 'member')).toBe(false);
  });
});

describe('canViewAlbum', () => {
  it('個人アルバムは所有者のみ', () => {
    expect(canViewAlbum(userAlbum, 'owner', null)).toBe(true);
    expect(canViewAlbum(userAlbum, 'other', null)).toBe(false);
  });
  it('グループアルバムはメンバーのみ、非メンバーは不可', () => {
    expect(canViewAlbum(groupAlbum, 'member', group)).toBe(true);
    expect(canViewAlbum(groupAlbum, 'admin', group)).toBe(true);
    expect(canViewAlbum(groupAlbum, 'stranger', group)).toBe(false);
  });
});

describe('canCreateAlbum / canEditAlbum', () => {
  it('グループ作成はメンバーのみ', () => {
    expect(canCreateAlbum('group', 'g1', 'member', group)).toBe(true);
    expect(canCreateAlbum('group', 'g1', 'stranger', group)).toBe(false);
  });
  it('編集は作成者のみ', () => {
    expect(canEditAlbum(groupAlbum, 'member')).toBe(true); // createdBy=member
    expect(canEditAlbum(groupAlbum, 'admin')).toBe(false);
  });
});

describe('canUploadMedia', () => {
  it('メンバーは可、非メンバーは不可', () => {
    expect(canUploadMedia(groupAlbum, 'member', group)).toBe(true);
    expect(canUploadMedia(groupAlbum, 'stranger', group)).toBe(false);
  });
});

describe('canDeleteMedia', () => {
  it('個人アルバムは所有者のみ', () => {
    expect(canDeleteMedia(userAlbum, media('owner'), 'owner', null)).toBe(true);
    expect(canDeleteMedia(userAlbum, media('owner'), 'other', null)).toBe(false);
  });
  it('グループは投稿者または管理者', () => {
    expect(canDeleteMedia(groupAlbum, media('member'), 'member', group)).toBe(true); // 投稿者
    expect(canDeleteMedia(groupAlbum, media('member'), 'admin', group)).toBe(true); // 管理者
    expect(canDeleteMedia(groupAlbum, media('member'), 'other', group)).toBe(false);
  });
});

describe('canPostComment / canDeleteComment', () => {
  it('投稿は閲覧権限者', () => {
    expect(canPostComment(groupAlbum, 'member', group)).toBe(true);
    expect(canPostComment(groupAlbum, 'stranger', group)).toBe(false);
  });
  it('削除は投稿者または（グループなら）管理者', () => {
    expect(canDeleteComment(groupAlbum, comment('member'), 'member', group)).toBe(true);
    expect(canDeleteComment(groupAlbum, comment('member'), 'admin', group)).toBe(true);
    expect(canDeleteComment(groupAlbum, comment('member'), 'other', group)).toBe(false);
  });
  it('個人アルバムのコメント削除は投稿者のみ（管理者概念なし）', () => {
    expect(canDeleteComment(userAlbum, comment('owner'), 'owner', null)).toBe(true);
    expect(canDeleteComment(userAlbum, comment('owner'), 'other', null)).toBe(false);
  });
});

describe('canManageInvite', () => {
  it('管理者のみ', () => {
    expect(canManageInvite(group, 'admin')).toBe(true);
    expect(canManageInvite(group, 'member')).toBe(false);
  });
});
