// ホーム画面。ログイン後の入口。保留中アップロードをバナー/件数で表示する（要件9）。
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../store/session.js';
import { listPending, removePending, type PendingUpload } from '../features/upload/pendingStore.js';

function formatMb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024 / 1024))}MB`;
}

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
    <main>
      <h1>ホーム</h1>
      {displayName && <p>{displayName} さん、こんにちは。</p>}

      {pending.length > 0 && (
        <section aria-label="保留中アップロード" style={{ border: '1px solid #c06', padding: 12 }}>
          <strong>Wi-Fi待ちの保留アップロードが {pending.length} 件あります</strong>
          <p>
            「再開する」からアルバムを開き、同じファイルを選び直すとアップロードを再開します
            （ファイル名・サイズ・更新日時で同じファイルか照合します）。この記録はこのブラウザにだけ保存されています。
          </p>
          <ul>
            {pending.map((p) => (
              <li key={p.id}>
                {p.fileName}（{formatMb(p.byteSize)}）{' '}
                <Link to={`/albums/${encodeURIComponent(p.albumId)}`}>再開する</Link>{' '}
                <button type="button" onClick={() => void cancel(p.id)}>
                  取り消す
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <nav aria-label="ホームのメニュー">
        <Link to="/albums">アルバム・グループ一覧へ</Link>
      </nav>
    </main>
  );
}
