// メディアビューア（モーダル）。権限確認後の原本表示・動画再生・保存・削除・表紙設定・再処理。
// 動画は再生URLの期限切れ時に自動再取得し、再生位置から続ける（要件5-8）。
// 横にフリックすると、一覧の前後のメディアに移る（グリッドと同じ並び順）。
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { TRASH_RETENTION_DAYS, type Album, type MediaListItem } from '@photo-album/shared';
import { api, errorMessage } from '../services/api.js';
import { useSession } from '../store/session.js';
import { swipeDirection } from '../lib/swipe.js';
import { CommentPanel } from './CommentPanel.js';
import { Alert, Button, Loading, Modal } from './ui/index.js';
import styles from './MediaViewer.module.css';

/** ブラウザで再生できない可能性があるコーデックか（H.264 以外, 要件5-12）。 */
function mayNotPlay(codec: string | null): boolean {
  return !!codec && codec !== 'h264';
}

export function MediaViewer({
  media,
  album,
  items,
  hasMore,
  onSelect,
  onLoadMore,
  onClose,
  onChanged,
}: {
  media: MediaListItem;
  album: Album;
  /** 表示中のアルバムの一覧（グリッドと同じ並び）。前後への移動に使う。 */
  items: MediaListItem[];
  /** 一覧に読み込んでいない続きがあるか。 */
  hasMore: boolean;
  /** 別のメディアに移る（前後への移動）。 */
  onSelect: (next: MediaListItem) => void;
  /** 続きを読み込む（読み込みが終わったら、次のメディアへ移る）。 */
  onLoadMore: () => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { userId } = useSession();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [playbackIssue, setPlaybackIssue] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const resumeAt = useRef<number | null>(null);
  const refreshCount = useRef(0);
  /** 今表示しているメディアのID。移動の途中で届いた古い応答を捨てるために使う。 */
  const activeId = useRef(media.mediaId);
  /** 続きの読み込み中に、次のメディアへ移るための待ち受け（読み込み前の件数）。 */
  const pendingFrom = useRef<number | null>(null);
  const swipeStart = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const ready = media.status === 'ready';

  const index = items.findIndex((m) => m.mediaId === media.mediaId);
  const prev = index > 0 ? items[index - 1]! : null;
  const next = index >= 0 ? (items[index + 1] ?? null) : null;

  const kind = media.kind === 'video' ? 'video' : 'original';

  // 別のメディアに移ったら、前のメディアの状態（URL・エラー・動画の再生位置）を捨てる
  useEffect(() => {
    activeId.current = media.mediaId;
    setUrl(null);
    setError(null);
    setNotice(null);
    setPlaybackIssue(false);
    refreshCount.current = 0;
    resumeAt.current = null;
  }, [media.mediaId]);

  const loadUrl = useCallback(async () => {
    if (!ready) return;
    const id = media.mediaId;
    try {
      const res = await api.media.url(id, kind);
      if (activeId.current !== id) return;
      setUrl(res.url);
      setError(null);
    } catch (err) {
      if (activeId.current !== id) return;
      setError(errorMessage(err, '表示できませんでした。'));
    }
  }, [media.mediaId, kind, ready]);

  useEffect(() => {
    void loadUrl();
  }, [loadUrl]);

  // 続きの読み込みが終わったら、待っていた次のメディアへ移る
  useEffect(() => {
    const from = pendingFrom.current;
    if (from === null || items.length <= from) return;
    pendingFrom.current = null;
    const first = items[from];
    if (first) onSelect(first);
  }, [items, onSelect]);

  /** 動画の読み込みエラー: URL期限切れなら再取得して再生位置から続ける。同じURLなら再生不可と判断する。 */
  async function onVideoError() {
    const position = videoRef.current?.currentTime ?? 0;
    try {
      const res = await api.media.url(media.mediaId, 'video');
      if (res.url !== url && refreshCount.current < 3) {
        refreshCount.current++;
        resumeAt.current = position;
        setUrl(res.url);
        return;
      }
    } catch {
      // 再取得できなければ下の案内を出す
    }
    setPlaybackIssue(true);
  }

  function onLoadedMetadata() {
    const v = videoRef.current;
    if (v && resumeAt.current !== null) {
      v.currentTime = resumeAt.current;
      resumeAt.current = null;
      void v.play().catch(() => {});
    }
  }

  async function download() {
    try {
      const res = await api.media.url(media.mediaId, 'download');
      window.location.href = res.url;
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove() {
    if (!confirm(`このメディアを削除しますか？ 一覧から消え、約${TRASH_RETENTION_DAYS}日後に完全に削除されます。`)) return;
    try {
      await api.media.remove(media.mediaId);
      onChanged();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function setAsCover() {
    try {
      await api.albums.update(album.albumId, { coverMediaId: media.mediaId });
      setNotice('表紙に設定しました。');
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function reprocess() {
    try {
      await api.media.reprocess(media.mediaId);
      setNotice('再処理を受け付けました。しばらくすると一覧に反映されます。');
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  /** 次のメディアへ。一覧の最後まで読み込んでいて続きがあれば、読み込んでから移る。 */
  function goNext() {
    if (next) {
      onSelect(next);
    } else if (hasMore && index >= 0) {
      pendingFrom.current = items.length;
      onLoadMore();
    }
  }

  function goPrev() {
    if (prev) onSelect(prev);
  }

  // 写真・動画の上でのフリックを、前後の移動に変える（縦スクロールとは touch-action: pan-y で分ける）
  function onSwipePointerDown(e: ReactPointerEvent<HTMLElement>) {
    if (!e.isPrimary) return;
    swipeStart.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
  }

  function onSwipePointerUp(e: ReactPointerEvent<HTMLElement>) {
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || start.pointerId !== e.pointerId) return;
    const direction = swipeDirection(e.clientX - start.x, e.clientY - start.y);
    if (direction === 'next') goNext();
    else if (direction === 'prev') goPrev();
  }

  function onSwipePointerCancel() {
    swipeStart.current = null;
  }

  const swipeHandlers = {
    onPointerDown: onSwipePointerDown,
    onPointerUp: onSwipePointerUp,
    onPointerCancel: onSwipePointerCancel,
  };

  const isPoster = media.createdBy === userId;
  const canDelete = ready || media.status === 'error'; // 処理中は24時間後に自動で失効・片付け（要件7-10, 7-11）

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={
        <>
          <span aria-hidden="true">{media.kind === 'video' ? '🎞️ ' : '🖼️ '}</span>
          {media.displayFileName}
        </>
      }
      footer={
        <>
          {ready && (
            <Button icon="⬇️" onClick={() => void download()}>
              保存
            </Button>
          )}
          {ready && media.kind === 'photo' && album.createdBy === userId && (
            <Button variant="secondary" icon="⭐" onClick={() => void setAsCover()}>
              表紙にする
            </Button>
          )}
          {media.status === 'error' && media.errorReason === 'preview_failed' && isPoster && (
            <Button variant="primary" icon="🔄" onClick={() => void reprocess()}>
              再処理
            </Button>
          )}
          {canDelete && (
            <Button variant="danger" icon="🗑️" onClick={() => void remove()}>
              削除
            </Button>
          )}
        </>
      }
    >
      <div className={styles.body}>
        {error && <Alert tone="danger">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}

        {!ready && (
          <Alert tone={media.status === 'error' ? 'danger' : 'info'} role="note" icon={media.status === 'error' ? '⚠️' : '⏳'}>
            {media.status === 'error'
              ? media.errorReason === 'invalid_file'
                ? 'このファイルは対応していない形式か、壊れているため表示できません。写真はJPEG/PNG/WebP、動画はMP4/MOV(H.264)をご利用ください。'
                : 'プレビューを作成できませんでした。「再処理」するか、削除してアップロードし直してください。'
              : 'アップロード後の確認処理中です。しばらくお待ちください。'}
          </Alert>
        )}

        {ready && !url && !error && <Loading />}

        {ready && url && media.kind === 'photo' && (
          <div className={styles.stage} {...swipeHandlers}>
            <img
              src={url}
              alt={media.displayFileName}
              className={styles.media}
              draggable={false}
            />
          </div>
        )}
        {ready && url && media.kind === 'video' && (
          <>
            {mayNotPlay(media.videoCodec) && (
              <Alert tone="warning" role="note">
                この動画（{media.videoCodec}）はお使いのブラウザで再生できない場合があります。再生できないときは「保存」して端末で再生してください。
              </Alert>
            )}
            <div className={styles.stage} {...swipeHandlers}>
              <video
                ref={videoRef}
                src={url}
                controls
                playsInline
                onError={() => void onVideoError()}
                onLoadedMetadata={onLoadedMetadata}
                className={styles.media}
              />
            </div>
            {playbackIssue && (
              <Alert tone="danger">
                この動画を再生できませんでした。お使いのブラウザが動画の形式に対応していない可能性があります。「保存」して端末で再生してください。
              </Alert>
            )}
          </>
        )}

        {ready && (prev || next || hasMore) && (
          <p className={styles.hint} role="note">
            左右にスワイプすると、前後の{media.kind === 'video' ? '動画' : '写真'}に移ります。
          </p>
        )}

        {/* コメントは移動のたびに読み直す（前のメディアの返信先などを残さない） */}
        {ready && <CommentPanel key={media.mediaId} targetType="media" targetId={media.mediaId} compact />}
      </div>
    </Modal>
  );
}
