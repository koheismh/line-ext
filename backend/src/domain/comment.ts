// コメント2階層ルール（純粋関数）。
// design.md「コメント」「Correctness Properties」に準拠。
// 階層は root + children の2階層のみ。孫は作らない。

import type { Comment } from '@photo-album/shared';

/** コメントが root か。 */
export function isRoot(c: Pick<Comment, 'commentId' | 'rootCommentId'>): boolean {
  return c.commentId === c.rootCommentId;
}

/** 表示可能（墓標でない active）か。 */
export function isDisplayable(c: Pick<Comment, 'status'>): boolean {
  return c.status === 'active';
}

/**
 * 新規コメント投稿時の rootCommentId を決める。
 * - 返信先が無い: 自分が root（commentId と同一）
 * - 返信先が root: その root 直下
 * - 返信先が child: その child の root 直下（＝同一 root。孫にしない）
 */
export function resolveRootCommentId(
  newCommentId: string,
  replyTo: Pick<Comment, 'commentId' | 'rootCommentId'> | null,
): string {
  if (!replyTo) return newCommentId;
  return replyTo.rootCommentId;
}

/**
 * コメント削除後のレコードを返す（純粋。元は変更しない）。
 * - 親(root): 本文を空にして status=deleted の墓標を残す（子は別途保持）
 * - 子: status=deleted にして非表示
 * いずれも他のコメントは変更しない。
 */
export function markDeleted(c: Comment, deletedAt: string): Comment {
  return { ...c, status: 'deleted', body: '', deletedAt };
}

/**
 * スレッド表示のための整形。
 * - 各 root について、表示可能な子（active）を時刻順に並べる
 * - root が墓標でも、表示可能な子が1件以上あれば墓標として表示する
 * - root が墓標で表示可能な子が0件なら、その root ごと非表示にする
 */
export interface ThreadView {
  root: Comment;
  /** 墓標の root を表示するか（子がある場合 true）。 */
  showRoot: boolean;
  children: Comment[];
}

export function buildThreads(comments: Comment[]): ThreadView[] {
  const roots = comments
    .filter((c) => isRoot(c))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  const threads: ThreadView[] = [];
  for (const root of roots) {
    const children = comments
      .filter((c) => !isRoot(c) && c.rootCommentId === root.commentId && isDisplayable(c))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

    const rootActive = isDisplayable(root);
    if (!rootActive && children.length === 0) {
      // 墓標で子もいない → スレッドごと非表示
      continue;
    }
    threads.push({ root, showRoot: rootActive || children.length > 0, children });
  }
  return threads;
}
