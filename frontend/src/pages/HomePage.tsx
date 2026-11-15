// ホーム画面。ログイン後の入口。保留中アップロードをバナー/件数で表示する（要件9）。
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../store/session.js';
import { listPending, removePending, type PendingUpload } from '../features/upload/pendingStore.js';
import { formatMb } from '../lib/format.js';
import { Badge, Button, Card, CardTitle, Page, buttonClassName } from '../components/ui/index.js';
import styles from './HomePage.module.css';

export function HomePage() {
  const { displayName } = useSession();
  const [pending, setPending] = useState<PendingUpload[]>([]);

  async function refresh() {
    try {
      setPending(await listPending());
    } catch {
      setPending([]); // IndexedDB が使えない環境（プライベートブラウズ等）
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function cancel(id: string) {
    await removePending(id);
    await refresh();
  }

  return (
    <Page title={`こんにちは、${displayName ?? ''} さん`} emoji="👋">
      {pending.length > 0 && (
        <Card as="section" tone="secondary" aria-labelledby="pending-title">
          <CardTitle id="pending-title" emoji="📶">
            Wi-Fi待ちのアップロード <Badge tone="primary">{pending.length}件</Badge>
          </CardTitle>
          <p className={styles.muted}>
            「再開する」からアルバムを開き、同じファイルを選び直すとアップロードを再開します（ファイル名・サイズ・更新日時で照合します）。この記録はこのブラウザにだけ保存されています。
          </p>
          <ul className={styles.pendingList}>
            {pending.map((p) => (
              <li key={p.id} className={styles.pendingItem}>
                <span className={styles.fileIcon} aria-hidden="true">
                  {p.mimeType.startsWith('video/') ? '🎞️' : '🖼️'}
                </span>
                <span className={styles.fileName}>
                  {p.fileName}
                  <span className={styles.fileSize}>{formatMb(p.byteSize)}</span>
                </span>
                <span className={styles.pendingActions}>
                  <Link
                    to={`/albums/${encodeURIComponent(p.albumId)}`}
                    className={buttonClassName({ variant: 'primary', size: 'sm' })}
                  >
                    再開する
                  </Link>
                  <Button size="sm" variant="ghost" onClick={() => void cancel(p.id)}>
                    取り消す
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Link to="/albums" className={styles.bigLink}>
        <span className={styles.bigLinkEmoji} aria-hidden="true">
          📚
        </span>
        <span className={styles.bigLinkText}>
          <strong>アルバム・グループ</strong>
          <span>写真や動画を見たり、追加したりできます</span>
        </span>
        <span className={styles.bigLinkArrow} aria-hidden="true">
          →
        </span>
      </Link>
    </Page>
  );
}
