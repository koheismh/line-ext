import { describe, it, expect } from 'vitest';
import { resolveRootCommentId, markDeleted, buildThreads, isRoot } from './comment.js';
import type { Comment } from '@photo-album/shared';

function c(id: string, root: string, status: Comment['status'], createdAt: string): Comment {
  return {
    commentId: id,
    targetType: 'album',
    targetId: 'A',
    rootCommentId: root,
    replyToCommentId: null,
    body: status === 'deleted' ? '' : `body-${id}`,
    status,
    authorUserId: 'u1',
    createdAt,
    deletedAt: status === 'deleted' ? createdAt : null,
  };
}

describe('resolveRootCommentId', () => {
  it('返信先なしは自分がroot', () => {
    expect(resolveRootCommentId('x', null)).toBe('x');
  });
  it('rootへの返信はそのroot直下', () => {
    expect(resolveRootCommentId('x', { commentId: 'r', rootCommentId: 'r' })).toBe('r');
  });
  it('childへの返信も同じroot直下（孫にしない）', () => {
    expect(resolveRootCommentId('x', { commentId: 'ch', rootCommentId: 'r' })).toBe('r');
  });
});

describe('markDeleted', () => {
  it('本文を空にしstatus=deleted・deletedAt付与、他は不変', () => {
    const original = c('r', 'r', 'active', '2026-01-01T00:00:00Z');
    const deleted = markDeleted(original, '2026-02-01T00:00:00Z');
    expect(deleted.status).toBe('deleted');
    expect(deleted.body).toBe('');
    expect(deleted.deletedAt).toBe('2026-02-01T00:00:00Z');
    // 元オブジェクトは変更しない（純粋）
    expect(original.status).toBe('active');
    expect(original.body).toBe('body-r');
  });
});

describe('buildThreads', () => {
  it('rootとactiveな子を時刻順に並べる', () => {
    const comments = [
      c('r', 'r', 'active', '2026-01-01T00:00:00Z'),
      c('c2', 'r', 'active', '2026-01-03T00:00:00Z'),
      c('c1', 'r', 'active', '2026-01-02T00:00:00Z'),
    ];
    const threads = buildThreads(comments);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.children.map((x) => x.commentId)).toEqual(['c1', 'c2']);
  });

  it('親が墓標でも子が残れば墓標を表示', () => {
    const comments = [
      c('r', 'r', 'deleted', '2026-01-01T00:00:00Z'),
      c('c1', 'r', 'active', '2026-01-02T00:00:00Z'),
    ];
    const threads = buildThreads(comments);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.showRoot).toBe(true);
    expect(threads[0]!.children).toHaveLength(1);
  });

  it('親が墓標で子が全滅ならスレッドごと非表示', () => {
    const comments = [
      c('r', 'r', 'deleted', '2026-01-01T00:00:00Z'),
      c('c1', 'r', 'deleted', '2026-01-02T00:00:00Z'),
    ];
    expect(buildThreads(comments)).toHaveLength(0);
  });

  it('削除された子は表示されない（非破壊：他は残る）', () => {
    const comments = [
      c('r', 'r', 'active', '2026-01-01T00:00:00Z'),
      c('c1', 'r', 'deleted', '2026-01-02T00:00:00Z'),
      c('c2', 'r', 'active', '2026-01-03T00:00:00Z'),
    ];
    const threads = buildThreads(comments);
    expect(threads[0]!.children.map((x) => x.commentId)).toEqual(['c2']);
  });
});

describe('isRoot', () => {
  it('commentId===rootCommentId なら root', () => {
    expect(isRoot({ commentId: 'r', rootCommentId: 'r' })).toBe(true);
    expect(isRoot({ commentId: 'c', rootCommentId: 'r' })).toBe(false);
  });
});
