// メディアビューア。権限確認後の原本表示・動画再生・保存・削除。
// 動画は再生URLの期限切れ時に自動再取得する。
import { useCallback, useEffect, useState } from 'react';
import type { MediaListItem } from '@photo-album/shared';
import { api, ApiClientError } from '../services/api.js';
import { CommentPanel } from './CommentPanel.js';

export function MediaViewer({
  media,
  onClose,
  onChanged,
}: {
  media: MediaListItem;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadUrl = useCallback(async () => {
    try {
      const kind = media.kind === 'video' ? 'video' : 'original';
      const res = await api.media.url(media.mediaId, kind);
      setUrl(res.url);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '表示できませんでした');
    }
  }, [media.mediaId, media.kind]);

  useEffect(() => {
    void loadUrl();
  }, [loadUrl]);

  async function download() {
    const res = await api.media.url(media.mediaId, 'download');
    window.location.href = res.url;
  }

  async function remove() {
    if (!confirm('このメディアを削除しますか？ この操作は元に戻せません。')) return;
    await api.media.remove(media.mediaId);
    onChanged();
    onClose();
  }

  return (
    <div role="dialog" aria-label="メディア表示" style={{ border: '1px solid #333', padding: 12 }}>
      <button type="button" onClick={onClose} aria-label="閉じる">
        閉じる
      </button>
      {error && <p role="alert">{error}</p>}
      {url && media.kind === 'photo' && <img src={url} alt="" style={{ maxWidth: '100%' }} />}
      {url && media.kind === 'video' && (
        // 期限切れ時は onError で再取得
        <video src={url} controls onError={() => void loadUrl()} style={{ maxWidth: '100%' }} />
      )}
      <div>
        <button type="button" onClick={() => void download()}>
          保存
        </button>
        <button type="button" onClick={() => void remove()}>
          削除
        </button>
      </div>
      <CommentPanel targetType="media" targetId={media.mediaId} />
    </div>
  );
}
