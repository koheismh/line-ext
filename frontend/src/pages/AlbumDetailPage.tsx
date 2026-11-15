// アルバム詳細。メディアグリッド（プレビュー）、ページング、アップロード、アルバム編集（作成者のみ）、
// ビューア、アルバムへのコメント。
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ALBUM_DESCRIPTION_MAX_LENGTH,
  ALBUM_TITLE_MAX_LENGTH,
  type Album,
  type MediaListItem,
} from '@photo-album/shared';
import { api, errorMessage } from '../services/api.js';
import { useSession } from '../store/session.js';
import { useUpload } from '../features/upload/useUpload.js';
import { listPending, type PendingUpload } from '../features/upload/pendingStore.js';
import { MediaViewer } from '../components/MediaViewer.js';
import { CommentPanel } from '../components/CommentPanel.js';
import { MediaGrid, isProcessing } from '../components/MediaGrid.js';
import { UploadPanel } from '../components/UploadPanel.js';
import {
  Alert,
  Button,
  Card,
  CardTitle,
  EmptyState,
  Field,
  Loading,
  Page,
} from '../components/ui/index.js';
import styles from './AlbumDetailPage.module.css';

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

  if (!album && !error) return <Loading />;

  return (
    <Page
      title={album?.title ?? 'アルバム'}
      emoji="🖼️"
      back={{ to: '/albums', label: 'アルバム一覧' }}
      lead={album?.description || undefined}
      actions={
        isCreator && !editing ? (
          <Button size="sm" icon="✏️" onClick={startEdit}>
            編集
          </Button>
        ) : undefined
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      {isCreator && editing && (
        <Card as="section" tone="secondary" aria-labelledby="edit-album">
          <CardTitle id="edit-album" emoji="✏️">
            アルバムを編集
          </CardTitle>
          <form className={styles.editForm} onSubmit={(e) => void saveEdit(e)}>
            <Field label="タイトル">
              <input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                maxLength={ALBUM_TITLE_MAX_LENGTH}
                required
              />
            </Field>
            <Field label="説明" hint="空でもかまいません">
              <textarea
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                maxLength={ALBUM_DESCRIPTION_MAX_LENGTH}
                rows={3}
              />
            </Field>
            <div className={styles.formActions}>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                やめる
              </Button>
              <Button type="submit" variant="primary">
                保存する
              </Button>
            </div>
          </form>
        </Card>
      )}

      {album && <UploadPanel upload={upload} pendings={pendings} />}

      {album && (
        <section aria-label="写真・動画" className={styles.media}>
          {items.length === 0 ? (
            <EmptyState emoji="📷" title="まだ写真・動画がありません">
              「写真・動画を追加」から思い出を入れてみましょう。
            </EmptyState>
          ) : (
            <MediaGrid items={items} onOpen={setViewing} />
          )}
          {nextToken && (
            <Button className={styles.more} onClick={() => setPageCount((c) => c + 1)}>
              もっと見る
            </Button>
          )}
        </section>
      )}

      {viewing && album && (
        <MediaViewer
          media={viewing}
          album={album}
          onClose={() => setViewing(null)}
          onChanged={() => void refresh()}
        />
      )}

      {album && <CommentPanel targetType="album" targetId={albumId} />}
    </Page>
  );
}
