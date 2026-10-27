// コメントパネル。2階層表示・投稿・返信（返信先の表示）・削除・root 単位のページング。
// 本文は React 標準のテキスト描画（dangerouslySetInnerHTML不使用＝XSS対策）。
import { useCallback, useEffect, useState } from 'react';
import { COMMENT_BODY_MAX_LENGTH, type Comment, type CommentThread } from '@photo-album/shared';
import { api, errorMessage } from '../services/api.js';
import { useSession } from '../store/session.js';

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
}

export function CommentPanel({
  targetType,
  targetId,
}: {
  targetType: 'album' | 'media';
  targetId: string;
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

  /** 子への返信なら「○○さんへの返信」を表示する（要件6-4）。 */
  function replyLabel(thread: CommentThread, c: Comment): string | null {
    if (!c.replyToCommentId || c.replyToCommentId === thread.root.commentId) return null;
    const target = thread.children.find((x) => x.commentId === c.replyToCommentId);
    return target ? `${nameOf(target.authorUserId)} さんへの返信` : '削除されたコメントへの返信';
  }

  return (
    <section aria-label="コメント">
      <h2>コメント</h2>
      {error && <p role="alert">{error}</p>}

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {threads.map((t) => (
          <li key={t.root.commentId} style={{ marginBottom: 8 }}>
            <div>
              {t.root.status === 'deleted' ? (
                <em>（削除されたコメント）</em>
              ) : (
                <>
                  <strong>{nameOf(t.root.authorUserId)}</strong>{' '}
                  <small>{formatTime(t.root.createdAt)}</small>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{t.root.body}</div>
                  <button type="button" onClick={() => setReplyTo(t.root)}>
                    返信
                  </button>
                  {canDelete(t.root) && (
                    <button type="button" onClick={() => void remove(t.root.commentId)}>
                      削除
                    </button>
                  )}
                </>
              )}
            </div>
            <ul style={{ listStyle: 'none', paddingLeft: 16 }}>
              {t.children.map((c) => (
                <li key={c.commentId}>
                  <strong>{nameOf(c.authorUserId)}</strong> <small>{formatTime(c.createdAt)}</small>
                  {replyLabel(t, c) && <small> ・{replyLabel(t, c)}</small>}
                  <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
                  <button type="button" onClick={() => setReplyTo(c)}>
                    返信
                  </button>
                  {canDelete(c) && (
                    <button type="button" onClick={() => void remove(c.commentId)}>
                      削除
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {nextToken && (
        <button type="button" onClick={() => void loadMore()}>
          さらに表示
        </button>
      )}

      <form onSubmit={(e) => void post(e)}>
        {replyTo && (
          <p>
            {nameOf(replyTo.authorUserId)} さんに返信中…{' '}
            <button type="button" onClick={() => setReplyTo(null)}>
              やめる
            </button>
          </p>
        )}
        <label>
          コメント
          <br />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
            maxLength={COMMENT_BODY_MAX_LENGTH}
          />
        </label>
        <br />
        <button type="submit" disabled={busy}>
          投稿
        </button>
      </form>
    </section>
  );
}
