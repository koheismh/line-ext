// コメントパネル。2階層表示・投稿・返信（返信先の表示）・削除・root 単位のページング。
// 本文は React 標準のテキスト描画（dangerouslySetInnerHTML不使用＝XSS対策）。
import { useCallback, useEffect, useState } from 'react';
import { COMMENT_BODY_MAX_LENGTH, type Comment, type CommentThread } from '@photo-album/shared';
import { api, errorMessage } from '../services/api.js';
import { useSession } from '../store/session.js';
import { formatDateTime } from '../lib/format.js';
import { Alert, Avatar, Badge, Button, Card, CardTitle, EmptyState, cx } from './ui/index.js';
import styles from './CommentPanel.module.css';

export function CommentPanel({
  targetType,
  targetId,
  compact = false,
}: {
  targetType: 'album' | 'media';
  targetId: string;
  /** モーダル内など、カードの枠を付けずに表示する */
  compact?: boolean;
}) {
  const { userId } = useSession();
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [authors, setAuthors] = useState<Record<string, string>>({});
  const [canModerate, setCanModerate] = useState(false);
  const [nextToken, setNextToken] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [busy, setBusy] = useState(false);

  /** 先頭から読み直す。all=true なら最後のページまで読む（投稿直後に新しいコメントを確実に表示する）。 */
  const refresh = useCallback(
    async (all = false) => {
      try {
        const collected: CommentThread[] = [];
        const names: Record<string, string> = {};
        let token: string | undefined;
        let moderate = false;
        do {
          const res = await api.comments.list(targetType, targetId, token);
          collected.push(...res.threads);
          Object.assign(names, res.authors);
          moderate = res.canModerate;
          token = res.nextToken;
        } while (all && token);
        setThreads(collected);
        setAuthors(names);
        setCanModerate(moderate);
        setNextToken(token);
        setError(null);
      } catch (err) {
        setError(errorMessage(err, 'コメントを取得できませんでした。'));
      }
    },
    [targetType, targetId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function loadMore() {
    if (!nextToken) return;
    try {
      const res = await api.comments.list(targetType, targetId, nextToken);
      setThreads((t) => [...t, ...res.threads]);
      setAuthors((a) => ({ ...a, ...res.authors }));
      setNextToken(res.nextToken);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function post(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api.comments.post({ targetType, targetId, body, replyToCommentId: replyTo?.commentId ?? null });
      setBody('');
      setReplyTo(null);
      await refresh(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(commentId: string) {
    if (!confirm('このコメントを削除しますか？')) return;
    try {
      await api.comments.remove(commentId);
      await refresh(true);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const nameOf = (id: string) => authors[id] ?? '(不明)';
  const canDelete = (c: Comment) => c.authorUserId === userId || canModerate;

  /** 子への返信なら「○○ さんへの返信」を表示する（要件6-4）。 */
  function replyLabel(thread: CommentThread, c: Comment): string | null {
    if (!c.replyToCommentId || c.replyToCommentId === thread.root.commentId) return null;
    const target = thread.children.find((x) => x.commentId === c.replyToCommentId);
    return target ? `${nameOf(target.authorUserId)} さんへの返信` : '削除されたコメントへの返信';
  }

  /** 1件分の吹き出し（コンポーネントにすると再描画のたびに作り直されフォーカスが外れるため、関数で描く）。 */
  function renderBubble(thread: CommentThread, comment: Comment, child = false) {
    const label = child ? replyLabel(thread, comment) : null;
    const mine = comment.authorUserId === userId;
    return (
      <div className={styles.comment}>
        <Avatar name={nameOf(comment.authorUserId)} seed={comment.authorUserId} size={child ? 'sm' : 'md'} />
        <div className={styles.main}>
          <div className={styles.meta}>
            <strong>{nameOf(comment.authorUserId)}</strong>
            {mine && <Badge tone="secondary">自分</Badge>}
            <span className={styles.time}>{formatDateTime(comment.createdAt)}</span>
          </div>
          {label && <span className={styles.replyLabel}>↩ {label}</span>}
          <div className={cx(styles.bubble, mine && styles.bubbleMine)}>{comment.body}</div>
          <div className={styles.actions}>
            <Button size="sm" variant="ghost" onClick={() => setReplyTo(comment)}>
              返信
            </Button>
            {canDelete(comment) && (
              <Button size="sm" variant="ghost" onClick={() => void remove(comment.commentId)}>
                削除
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const content = (
    <>
      <CardTitle emoji="💬">コメント</CardTitle>
      {error && <Alert tone="danger">{error}</Alert>}

      {threads.length === 0 && !error ? (
        <EmptyState emoji="💭" title="まだコメントはありません">
          最初のひとことを書いてみましょう。
        </EmptyState>
      ) : (
        <ul className={styles.threads}>
          {threads.map((t) => (
            <li key={t.root.commentId} className={styles.thread}>
              {t.root.status === 'deleted' ? (
                <p className={styles.tombstone}>（削除されたコメント）</p>
              ) : (
                renderBubble(t, t.root)
              )}
              {t.children.length > 0 && (
                <ul className={styles.children}>
                  {t.children.map((c) => (
                    <li key={c.commentId}>{renderBubble(t, c, true)}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {nextToken && (
        <Button size="sm" className={styles.more} onClick={() => void loadMore()}>
          さらに表示
        </Button>
      )}

      <form className={styles.form} onSubmit={(e) => void post(e)}>
        {replyTo && (
          <div className={styles.replying}>
            <span>
              <span aria-hidden="true">↩ </span>
              {nameOf(replyTo.authorUserId)} さんに返信中
            </span>
            <Button size="sm" variant="ghost" onClick={() => setReplyTo(null)}>
              やめる
            </Button>
          </div>
        )}
        <label className="visually-hidden" htmlFor={`comment-${targetType}-${targetId}`}>
          コメント
        </label>
        <textarea
          id={`comment-${targetType}-${targetId}`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          maxLength={COMMENT_BODY_MAX_LENGTH}
          placeholder="コメントを書く…"
        />
        <Button type="submit" variant="primary" disabled={busy || !body.trim()} className={styles.submit}>
          投稿する
        </Button>
      </form>
    </>
  );

  if (compact) {
    return (
      <section aria-label="コメント" className={styles.compact}>
        {content}
      </section>
    );
  }
  return (
    <Card as="section" aria-label="コメント" className={styles.panel}>
      {content}
    </Card>
  );
}
