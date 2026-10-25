// ホーム画面。ログイン後の入口。保留中アップロードをバナー/件数で表示する。
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listPending, removePending, type PendingUpload } from '../features/upload/pendingStore.js';

export function HomePage() {
  const [pending, setPending] = useState<PendingUpload[]>([]);

  async function refresh() {
    setPending(await listPending());
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

      {pending.length > 0 && (
        <section aria-label="保留中アップロード" style={{ border: '1px solid #e0a', padding: 12 }}>
          <strong>Wi-Fi待ちの保留アップロードが {pending.length} 件あります</strong>
          <p>Wi-Fi環境で、各アルバムを開いて同じファイルを選び直すと再開できます。</p>
          <ul>
            {pending.map((p) => (
              <li key={p.id}>
                {p.fileName}（{Math.round(p.byteSize / 1024 / 1024)}MB）
                {' / '}
                <Link to={`/albums/${p.albumId}`}>アルバムを開く</Link>
                {' / '}
                <button type="button" onClick={() => void cancel(p.id)}>
                  取り消す
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <nav>
        <Link to="/albums">アルバム一覧へ</Link>
      </nav>
    </main>
  );
}
