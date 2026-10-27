// アルバム詳細。メディアグリッド（プレビュー）、ページング、アップロード（回線ガード確認・結果表示）、
// 保留中アップロードの再開案内、アルバム編集（作成者のみ）、ビューア起動、アルバムへのコメント。
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ALBUM_DESCRIPTION_MAX_LENGTH,
  ALBUM_TITLE_MAX_LENGTH,
  SUPPORTED_MIME_TYPES,
  type Album,
  type MediaListItem,
} from '@photo-album/shared';
import { api, errorMessage } from '../services/api.js';
import { useSession } from '../store/session.js';
import { useUpload } from '../features/upload/useUpload.js';
import { listPending, type PendingUpload } from '../features/upload/pendingStore.js';
import { MediaViewer } from '../components/MediaViewer.js';
import { CommentPanel } from '../components/CommentPanel.js';

/** 処理中（自動更新の対象）か。 */
function isProcessing(m: MediaListItem): boolean {
  return m.status === 'uploading' || m.status === 'validating';
}

function tileText(m: MediaListItem): string {
  if (m.status === 'error') {
    return m.errorReason === 'invalid_file' ? '対応していないファイルです' : 'プレビューを作成できませんでした';
  }
  if (isProcessing(m)) return '処理中…';
  return m.kind === 'video' ? '動画' : '写真';
}

function MediaTile({ media, onOpen }: { media: MediaListItem; onOpen: () => void }) {
  const kindLabel = media.kind === 'video' ? '動画' : '写真';
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${kindLabel}「${media.displayFileName}」を開く`}
        style={{ padding: 0, border: media.status === 'error' ? '2px solid #c33' : '1px solid #ccc', position: 'relative' }}
      >
        {media.status === 'ready' && media.previewUrl ? (
          <img src={media.previewUrl} alt="" width={120} height={120} loading="lazy" style={{ objectFit: 'cover', display: 'block' }} />
        ) : (
          <span style={{ display: 'flex', width: 120, height: 120, background: '#eee', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>
            {tileText(media)}
          </span>
        )}
        {media.kind === 'video' && media.status === 'ready' && (
          <span aria-hidden="true" style={{ position: 'absolute', right: 4, bottom: 4, background: '#000a', color: '#fff', padding: '0 4px' }}>
            ▶
          </span>
        )}
      </button>
    </li>
  );
}

export function AlbumDetailPage() {
  const { albumId = '' } = useParams();
  const { userId } = useSession();
  const [album, setAlbum] = useState<Album | null>(null);
  const [items, setItems] = useState<MediaListItem[]>([]);
  const [pageCount, setPageCount] = useState(1);
  const [nextToken, setNextToken] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<MediaListItem | null>(null);
  const [pendings, setPendings] = useState<PendingUpload[]>([]);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const upload = useUpload(albumId);

  /** アルバムと、読み込み済みページ数分のメディアを取り直す（自動更新・操作後の再読込）。 */
  const refresh = useCallback(async () => {
    try {
      const a = await api.albums.get(albumId);
      const all: MediaListItem[] = [];
      let token: string | undefined;
      for (let i = 0; i < pageCount; i++) {
        const page = await api.albums.media(albumId, token);
        all.push(...page.items);
        token = page.nextToken;
        if (!token) break;
      }
      setAlbum(a);
      setItems(all);
      setNextToken(token);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, '読み込みに失敗しました。'));
    }
  }, [albumId, pageCount]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // このアルバムの保留中アップロード（同一ブラウザ内のみ, 要件9-7）
  useEffect(() => {
    listPending()
      .then((all) => setPendings(all.filter((p) => p.albumId === albumId)))
      .catch(() => setPendings([]));
  }, [albumId, upload.state.phase]);

  // アップロード完了後に一覧を更新
  useEffect(() => {
    if (upload.state.phase === 'done') void refresh();
  }, [upload.state.phase, refresh]);

  // 処理中メディアがあれば自動更新（ポーリング, 要件4-24）。失敗したものは対象外
  useEffect(() => {
    if (!items.some(isProcessing)) return;
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [items, refresh]);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // 同じファイルを選び直せるようにする
    if (files.length > 0) void upload.start(files);
  }

  function startEdit() {
    if (!album) return;
    setEditTitle(album.title);
    setEditDescription(album.description);
    setEditing(true);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const updated = await api.albums.update(albumId, {
        title: editTitle.trim(),
        description: editDescription,
      });
      setAlbum(updated);
      setEditing(false);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const isCreator = !!album && album.createdBy === userId;
  const uploading = upload.state.phase === 'uploading';

  return (
    <main>
      <p>
        <Link to="/albums">← アルバム一覧</Link>
      </p>
      <h1>{album?.title ?? 'アルバム'}</h1>
      {album?.description && <p style={{ whiteSpace: 'pre-wrap' }}>{album.description}</p>}
      {error && <p role="alert">{error}</p>}

      {isCreator && !editing && (
        <button type="button" onClick={startEdit}>
          タイトル・説明を編集
        </button>
      )}
      {isCreator && editing && (
        <form onSubmit={(e) => void saveEdit(e)} aria-label="アルバムを編集">
          <label>
            タイトル{' '}
            <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} maxLength={ALBUM_TITLE_MAX_LENGTH} required />
          </label>
          <br />
          <label>
            説明
            <br />
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              maxLength={ALBUM_DESCRIPTION_MAX_LENGTH}
              rows={3}
            />
          </label>
          <br />
          <button type="submit">保存</button>{' '}
          <button type="button" onClick={() => setEditing(false)}>
            やめる
          </button>
        </form>
      )}

      <section aria-label="アップロード">
        <label>
          写真・動画を追加{' '}
          <input
            type="file"
            multiple
            accept={SUPPORTED_MIME_TYPES.join(',')}
            onChange={onPick}
            disabled={uploading || upload.state.phase === 'confirm'}
          />
        </label>
        {pendings.length > 0 && (
          <div role="note" style={{ border: '1px solid #c06', padding: 8, marginTop: 8 }}>
            このアルバムに保留中のアップロードが {pendings.length} 件あります。同じファイルを選び直すとアップロードを再開します:
            <ul>
              {pendings.map((p) => (
                <li key={p.id}>
                  {p.fileName}（{Math.max(1, Math.round(p.byteSize / 1024 / 1024))}MB）
                </li>
              ))}
            </ul>
          </div>
        )}
        {uploading && (
          <p role="status">
            アップロード中… {Math.round(upload.state.progress * 100)}%（完了まで画面を閉じないでください）
          </p>
        )}
        {upload.state.results.length > 0 && !uploading && (
          <ul aria-label="アップロード結果">
            {upload.state.results.map((r, i) => (
              <li key={`${r.name}-${i}`}>
                {r.ok ? '送信完了' : '失敗'}: {r.name}
                {r.ok ? '（確認処理が終わると一覧に表示されます）' : `（${r.message ?? ''}）`}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 回線ガード確認（要件4-17〜4-19） */}
      {upload.state.phase === 'confirm' && (
        <div role="dialog" aria-label="アップロード確認" style={{ border: '1px solid #c33', padding: 12 }}>
          <p>
            {upload.state.reason === 'cellular'
              ? 'モバイル回線です。大きなファイルのため通信量にご注意ください。'
              : 'このブラウザでは回線の種類を確認できません。大きなファイルのため、Wi-Fi でない場合は通信量にご注意ください。'}
          </p>
          <button type="button" onClick={() => void upload.approve()}>
            それでもアップロード（24時間確認しない）
          </button>{' '}
          <button type="button" onClick={() => void upload.defer()}>
            Wi-Fiまで保留にする
          </button>
        </div>
      )}

      {/* メディアグリッド（プレビューのみ。原本はビューアで要求時に取得） */}
      <ul style={{ display: 'flex', flexWrap: 'wrap', listStyle: 'none', gap: 8, padding: 0 }}>
        {items.map((m) => (
          <MediaTile key={m.mediaId} media={m} onOpen={() => setViewing(m)} />
        ))}
      </ul>
      {items.length === 0 && !error && <p>まだ写真・動画がありません。</p>}
      {nextToken && (
        <button type="button" onClick={() => setPageCount((c) => c + 1)}>
          もっと見る
        </button>
      )}

      {viewing && album && (
        <MediaViewer
          media={viewing}
          album={album}
          onClose={() => setViewing(null)}
          onChanged={() => void refresh()}
        />
      )}

      <CommentPanel targetType="album" targetId={albumId} />
    </main>
  );
}
