// コメントパネル。2階層表示・投稿・返信・削除。
// 本文は React 標準のテキスト描画（dangerouslySetInnerHTML不使用＝XSS対策）。
import { useCallback, useEffect, useState } from 'react';
import type { Comment } from '@photo-album/shared';
import { api, ApiClientError } from '../services/api.js';

interface ThreadView {
  root: Comment;
  showRoot: boolean;
  children: Comment[];
}

export function CommentPanel({
  targetType,
  targetId,
}: {
  targetType: 'album' | 'media';
  targetId: string;
}) {
  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.comments.list(targetType, targetId);
      setThreads(res.threads as ThreadView[]);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'コメントを取得できませんでした');
    }
  }, [targetType, targetId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function post() {
    if (!body.trim()) return;
    await api.comments.post({ targetType, targetId, body: body.trim(), replyToCommentId: replyTo });
    setBody('');
    setReplyTo(null);
    await refresh();
  }

  async function remove(commentId: string) {
    await api.comments.remove(commentId);
    await refresh();
  }

  return (
    <section aria-label="コメント">
      <h2>コメント</h2>
      {error && <p role="alert">{error}</p>}

      <ul style={{ listStyle: 'none', padding: 0 }}>
        {threads.map((t) => (
          <li key={t.root.commentId} style={{ marginBottom: 8 }}>
            {/* 墓標は本文空。showRootがtrueなら枠だけ表示 */}
            <div>
              {t.root.status === 'deleted' ? (
                <em>（削除されたコメント）</em>
              ) : (
                <span>{t.root.body}</span>
              )}
              {t.root.status !== 'deleted' && (
                <>
                  {' '}
                  <button type="button" onClick={() => setReplyTo(t.root.commentId)}>
                    返信
                  </button>
                  <button type="button" onClick={() => void remove(t.root.commentId)}>
                    削除
                  </button>
                </>
              )}
            </div>
            <ul style={{ listStyle: 'none', paddingLeft: 16 }}>
              {t.children.map((c) => (
                <li key={c.commentId}>
                  <span>{c.body}</span>{' '}
                  <button type="button" onClick={() => setReplyTo(t.root.commentId)}>
                    返信
                  </button>
                  <button type="button" onClick={() => void remove(c.commentId)}>
                    削除
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      <div>
        {replyTo && <p>返信中… <button type="button" onClick={() => setReplyTo(null)}>やめる</button></p>}
        <textarea
          aria-label="コメント本文"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
        />
        <button type="button" onClick={() => void post()}>
          投稿
        </button>
      </div>
    </section>
  );
}
