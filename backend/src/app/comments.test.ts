import { describe, it, expect, beforeEach } from 'vitest';
import { s3 } from '../repo/s3Client.js';
import { installMemoryS3, type MemoryS3 } from '../testing/memoryS3.js';
import { metaKeys } from '../repo/keys.js';
import { listComments, postComment, deleteComment } from './comments.js';
import { AppError } from './errors.js';
import type { Album, Group, Media, Comment } from '@photo-album/shared';

let mem: MemoryS3;
const ctx = { metaBucket: 'meta', mediaBucket: 'media' };
const base = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };

function seedAlbum() {
  const group: Group = {
    groupId: 'g1', name: 'f', adminUserIds: ['admin'], memberUserIds: ['admin', 'member', 'other'],
    createdBy: 'admin', ...base,
  };
  const album: Album = {
    albumId: 'a1', ownerType: 'group', ownerId: 'g1', title: 't', description: '',
    coverMediaId: null, coverSource: 'auto', createdBy: 'member', ...base,
  };
  mem.put(metaKeys.group('g1'), group);
  mem.put(metaKeys.album('group', 'g1', 'a1'), album);
  mem.put(metaKeys.albumLocator('a1'), { ownerType: 'group', ownerId: 'g1' });
}

function seedMedia(mediaId: string, status: Media['status']) {
  const m: Media = {
    mediaId, albumId: 'a1', kind: 'photo', status, errorReason: null, originalExt: 'jpg',
    displayFileName: 'f', declaredByteSize: 1, declaredMimeType: 'image/jpeg', byteSize: 1,
    mimeType: 'image/jpeg', videoCodec: null, capturedAt: null, fileLastModified: null,
    uploadId: null, createdBy: 'member', ...base,
  };
  mem.put(metaKeys.media('a1', mediaId), m);
  mem.put(metaKeys.mediaLocator(mediaId), { albumId: 'a1', ownerType: 'group', ownerId: 'g1' });
}

beforeEach(() => {
  mem = installMemoryS3(s3);
  seedAlbum();
});

describe('postComment / listComments', () => {
  it('アルバムへ投稿し、スレッドに表示される', async () => {
    const c = await postComment(ctx, 'member', { targetType: 'album', targetId: 'a1', body: 'hello' }, '2026-02-01T00:00:00Z');
    expect(c.rootCommentId).toBe(c.commentId); // root
    const threads = await listComments(ctx, 'album', 'a1', 'member');
    expect(threads).toHaveLength(1);
    expect(threads[0]!.root.body).toBe('hello');
  });

  it('返信は同一root直下（孫を作らない）', async () => {
    const root = await postComment(ctx, 'member', { targetType: 'album', targetId: 'a1', body: 'root' }, '2026-02-01T00:00:00Z');
    const child = await postComment(ctx, 'other', { targetType: 'album', targetId: 'a1', body: 'reply', replyToCommentId: root.commentId }, '2026-02-02T00:00:00Z');
    // 子への返信も root 直下
    const grand = await postComment(ctx, 'member', { targetType: 'album', targetId: 'a1', body: 'reply2', replyToCommentId: child.commentId }, '2026-02-03T00:00:00Z');
    expect(child.rootCommentId).toBe(root.commentId);
    expect(grand.rootCommentId).toBe(root.commentId);

    const threads = await listComments(ctx, 'album', 'a1', 'member');
    expect(threads).toHaveLength(1);
    expect(threads[0]!.children).toHaveLength(2);
  });

  it('XSS対策：本文は生値で保存（エスケープしない）', async () => {
    const c = await postComment(ctx, 'member', { targetType: 'album', targetId: 'a1', body: '<b>A&B</b>' }, 'now');
    const stored = mem.get(metaKeys.comment('album', 'a1', c.commentId, c.commentId)) as Comment;
    expect(stored.body).toBe('<b>A&B</b>');
  });

  it('非メンバーは投稿も一覧も404', async () => {
    await expect(
      postComment(ctx, 'stranger', { targetType: 'album', targetId: 'a1', body: 'x' }, 'now'),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 404);
    await expect(listComments(ctx, 'album', 'a1', 'stranger')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 404,
    );
  });

  it('対象メディアが deleting 以降なら投稿拒否・一覧非表示', async () => {
    seedMedia('m1', 'deleting');
    await expect(
      postComment(ctx, 'member', { targetType: 'media', targetId: 'm1', body: 'x' }, 'now'),
    ).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.status === 404);
    await expect(listComments(ctx, 'media', 'm1', 'member')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 404,
    );
  });
});

describe('deleteComment', () => {
  it('親削除で墓標、子は残る', async () => {
    const root = await postComment(ctx, 'member', { targetType: 'album', targetId: 'a1', body: 'root' }, 't1');
    await postComment(ctx, 'other', { targetType: 'album', targetId: 'a1', body: 'child', replyToCommentId: root.commentId }, 't2');

    await deleteComment(ctx, root.commentId, 'member', '2026-03-01T00:00:00Z');
    const threads = await listComments(ctx, 'album', 'a1', 'member');
    expect(threads).toHaveLength(1);
    expect(threads[0]!.showRoot).toBe(true); // 墓標として表示
    expect(threads[0]!.root.body).toBe(''); // 本文消去
    expect(threads[0]!.children).toHaveLength(1); // 子は残る
  });

  it('子削除は非表示、rootは影響なし', async () => {
    const root = await postComment(ctx, 'member', { targetType: 'album', targetId: 'a1', body: 'root' }, 't1');
    const child = await postComment(ctx, 'other', { targetType: 'album', targetId: 'a1', body: 'child', replyToCommentId: root.commentId }, 't2');
    await deleteComment(ctx, child.commentId, 'other', '2026-03-01T00:00:00Z');
    const threads = await listComments(ctx, 'album', 'a1', 'member');
    expect(threads[0]!.root.body).toBe('root');
    expect(threads[0]!.children).toHaveLength(0);
  });

  it('投稿者でも管理者でもない者は削除不可(403)', async () => {
    const c = await postComment(ctx, 'member', { targetType: 'album', targetId: 'a1', body: 'x' }, 't1');
    await expect(deleteComment(ctx, c.commentId, 'other', 'now')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.status === 403,
    );
  });

  it('管理者は他人のコメントを削除できる', async () => {
    const c = await postComment(ctx, 'member', { targetType: 'album', targetId: 'a1', body: 'x' }, 't1');
    await deleteComment(ctx, c.commentId, 'admin', 'now');
    const threads = await listComments(ctx, 'album', 'a1', 'member');
    expect(threads).toHaveLength(0); // 墓標で子なし → 非表示
  });
});
