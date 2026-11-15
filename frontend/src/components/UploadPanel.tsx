// アップロード欄。ファイル選択・保留中アップロードの再開案内・進捗・ファイルごとの結果・回線ガードの確認。
// 動きのロジックは features/upload/useUpload.ts にあり、ここは表示だけを担当する。
import {
  MAX_PHOTO_BYTES,
  MAX_VIDEO_BYTES,
  SUPPORTED_MIME_TYPES,
} from '@photo-album/shared';
import type { useUpload } from '../features/upload/useUpload.js';
import type { PendingUpload } from '../features/upload/pendingStore.js';
import { formatMb } from '../lib/format.js';
import { Alert, Button, Card, Modal, ProgressBar, cx } from './ui/index.js';
import styles from './UploadPanel.module.css';

type Upload = ReturnType<typeof useUpload>;

export function UploadPanel({ upload, pendings }: { upload: Upload; pendings: PendingUpload[] }) {
  const { state } = upload;
  const uploading = state.phase === 'uploading';
  const disabled = uploading || state.phase === 'confirm';

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // 同じファイルを選び直せるようにする
    if (files.length > 0) void upload.start(files);
  }

  return (
    <Card as="section" aria-label="アップロード" className={styles.panel}>
      <label className={cx(styles.picker, disabled && styles.pickerDisabled)}>
        <input
          type="file"
          multiple
          accept={SUPPORTED_MIME_TYPES.join(',')}
          onChange={onPick}
          disabled={disabled}
          className="visually-hidden"
        />
        <span className={styles.pickerIcon} aria-hidden="true">
          ＋
        </span>
        <span className={styles.pickerText}>
          <strong>写真・動画を追加</strong>
          <span>
            JPEG / PNG / WebP / MP4 / MOV（写真{formatMb(MAX_PHOTO_BYTES)}・動画{formatMb(MAX_VIDEO_BYTES)}まで）
          </span>
        </span>
      </label>

      {pendings.length > 0 && (
        <Alert tone="warning" icon="📶" role="note" title={`保留中のアップロードが ${pendings.length} 件あります`}>
          <p>同じファイルを選び直すとアップロードを再開します。</p>
          <ul className={styles.fileList}>
            {pendings.map((p) => (
              <li key={p.id}>
                {p.fileName}（{formatMb(p.byteSize)}）
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {uploading && (
        <div role="status">
          <ProgressBar value={state.progress} label="アップロード中（完了まで画面を閉じないでください）" />
        </div>
      )}

      {state.results.length > 0 && !uploading && (
        <ul aria-label="アップロード結果" className={styles.results}>
          {state.results.map((r, i) => (
            <li key={`${r.name}-${i}`} className={cx(styles.result, !r.ok && styles.resultFailed)}>
              <span aria-hidden="true">{r.ok ? '✅' : '❌'}</span>
              <span className={styles.resultText}>
                <strong>{r.name}</strong>
                <span>
                  {r.ok ? '送信しました。確認処理が終わると一覧に表示されます。' : `失敗: ${r.message ?? ''}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* 回線ガードの確認（要件4-17〜4-19） */}
      <Modal
        open={state.phase === 'confirm'}
        onClose={upload.cancel}
        title="📶 通信量にご注意ください"
        size="sm"
        closeOnBackdrop={false}
        footer={
          <>
            <Button variant="ghost" onClick={upload.cancel}>
              やめる
            </Button>
            <Button variant="secondary" onClick={() => void upload.defer()}>
              Wi-Fiまで保留
            </Button>
            <Button variant="primary" onClick={() => void upload.approve()}>
              アップロードする
            </Button>
          </>
        }
      >
        <p>
          {state.reason === 'cellular'
            ? 'モバイル回線につながっています。大きなファイルのため、通信量が多くなります。'
            : 'このブラウザでは回線の種類を確認できません。Wi-Fi でない場合は通信量が多くなります。'}
        </p>
        <p className={styles.note}>「アップロードする」を選ぶと、24時間はこの確認を出しません。</p>
      </Modal>
    </Card>
  );
}
