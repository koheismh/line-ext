// メディアビューア（モーダル）。権限確認後の原本表示・動画再生・保存・削除・表紙設定・再処理。
// 動画は再生URLの期限切れ時に自動再取得し、再生位置から続ける（要件5-8）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { TRASH_RETENTION_DAYS, type Album, type MediaListItem } from '@photo-album/shared';
import { api, errorMessage } from '../services/api.js';
import { useSession } from '../store/session.js';
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
  onClose,
  onChanged,
}: {
  media: MediaListItem;
  album: Album;
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
  const ready = media.status === 'ready';

  const kind = media.kind === 'video' ? 'video' : 'original';

  const loadUrl = useCallback(async () => {
    if (!ready) return;
    try {
      const res = await api.media.url(media.mediaId, kind);
      setUrl(res.url);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, '表示できませんでした。'));
    }
  }, [media.mediaId, kind, ready]);

  useEffect(() => {
    void loadUrl();
  }, [loadUrl]);

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
          <div className={styles.stage}>
            <img src={url} alt={media.displayFileName} className={styles.media} />
          </div>
        )}
        {ready && url && media.kind === 'video' && (
          <>
            {mayNotPlay(media.videoCodec) && (
              <Alert tone="warning" role="note">
                この動画（{media.videoCodec}）はお使いのブラウザで再生できない場合があります。再生できないときは「保存」して端末で再生してください。
              </Alert>
            )}
            <div className={styles.stage}>
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

        {ready && <CommentPanel targetType="media" targetId={media.mediaId} compact />}
      </div>
    </Modal>
  );
}
