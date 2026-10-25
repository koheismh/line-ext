// アルバム詳細。メディアグリッド（プレビュー）、アップロード、回線ガード確認、ビューア起動。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Album, MediaListItem } from '@photo-album/shared';
import { api, ApiClientError } from '../services/api.js';
import { useUpload } from '../features/upload/useUpload.js';
import { MediaViewer } from '../components/MediaViewer.js';
import { CommentPanel } from '../components/CommentPanel.js';

export function AlbumDetailPage() {
  const { albumId = '' } = useParams();
  const [album, setAlbum] = useState<Album | null>(null);
  const [items, setItems] = useState<MediaListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<MediaListItem | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = useUpload(albumId);

  const refresh = useCallback(async () => {
    try {
      const [a, media] = await Promise.all([api.albums.get(albumId), api.albums.media(albumId)]);
      setAlbum(a);
      setItems(media.items);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '読み込みに失敗しました');
    }
  }, [albumId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // アップロード完了後に一覧を更新
  useEffect(() => {
    if (upload.state.phase === 'done') void refresh();
  }, [upload.state.phase, refresh]);

  // 処理中メディアがあれば自動更新（ポーリング）
  useEffect(() => {
    const hasProcessing = items.some((i) => i.previewUrl === null);
    if (!hasProcessing) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [items, refresh]);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) void upload.start(files);
  }

  return (
    <main>
      <h1>{album?.title ?? 'アルバム'}</h1>
      {error && <p role="alert">{error}</p>}

      <section>
        <input ref={fileRef} type="file" multiple accept="image/*,video/*" onChange={onPick} />
        {upload.state.phase === 'uploading' && (
          <p>アップロード中… {Math.round(upload.state.progress * 100)}%</p>
        )}
        {upload.state.phase === 'error' && <p role="alert">{upload.state.error}</p>}
      </section>

      {/* 回線ガード確認 */}
      {upload.state.phase === 'confirm' && (
        <div role="dialog" aria-label="アップロード確認" style={{ border: '1px solid #c33', padding: 12 }}>
          <p>
            {upload.state.reason === 'cellular'
              ? 'モバイル回線のようです。通信量にご注意ください。'
              : 'このブラウザでは回線の種類を確認できません。通信量にご注意ください。'}
          </p>
          <button type="button" onClick={() => void upload.approve()}>
            それでもアップロード（24時間確認しない）
          </button>
          <button type="button" onClick={() => void upload.defer()}>
            Wi-Fiまで保留にする
          </button>
        </div>
      )}

      {/* メディアグリッド（プレビューのみ） */}
      <ul style={{ display: 'flex', flexWrap: 'wrap', listStyle: 'none', gap: 8, padding: 0 }}>
        {items.map((m) => (
          <li key={m.mediaId}>
            <button type="button" onClick={() => setViewing(m)} aria-label={`${m.kind}を開く`}>
              {m.previewUrl ? (
                <img src={m.previewUrl} alt="" width={120} height={120} style={{ objectFit: 'cover' }} />
              ) : (
                <span style={{ display: 'inline-block', width: 120, height: 120, background: '#eee' }}>
                  処理中…
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {viewing && (
        <MediaViewer media={viewing} onClose={() => setViewing(null)} onChanged={() => void refresh()} />
      )}

      <CommentPanel targetType="album" targetId={albumId} />
    </main>
  );
}
