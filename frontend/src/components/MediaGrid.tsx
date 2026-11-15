// メディア一覧のグリッド（プレビューのみ。原本はビューアで要求時に取得する）。
// 処理中・失敗のメディア（投稿者本人にだけ返る）は状態が分かるタイルで表示する。
import type { MediaListItem } from '@photo-album/shared';
import { cx } from './ui/index.js';
import styles from './MediaGrid.module.css';

/** 処理中（自動更新の対象）か。 */
export function isProcessing(m: MediaListItem): boolean {
  return m.status === 'uploading' || m.status === 'validating';
}

function statusText(m: MediaListItem): { emoji: string; text: string } {
  if (m.status === 'error') {
    return m.errorReason === 'invalid_file'
      ? { emoji: '🚫', text: '対応していないファイルです' }
      : { emoji: '⚠️', text: 'プレビューを作れませんでした' };
  }
  return { emoji: '⏳', text: '処理中…' };
}

export function MediaGrid({
  items,
  onOpen,
}: {
  items: MediaListItem[];
  onOpen: (media: MediaListItem) => void;
}) {
  return (
    <ul className={styles.grid}>
      {items.map((m) => {
        const kindLabel = m.kind === 'video' ? '動画' : '写真';
        const ready = m.status === 'ready' && m.previewUrl;
        const status = statusText(m);
        return (
          <li key={m.mediaId}>
            <button
              type="button"
              onClick={() => onOpen(m)}
              aria-label={`${kindLabel}「${m.displayFileName}」を開く`}
              className={cx(styles.tile, m.status === 'error' && styles.error, isProcessing(m) && styles.processing)}
            >
              {ready ? (
                <img src={m.previewUrl!} alt="" loading="lazy" className={styles.image} />
              ) : (
                <span className={styles.status}>
                  <span className={styles.statusEmoji} aria-hidden="true">
                    {status.emoji}
                  </span>
                  <span>{status.text}</span>
                </span>
              )}
              {m.kind === 'video' && (
                <span className={styles.videoBadge} aria-hidden="true">
                  ▶
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
