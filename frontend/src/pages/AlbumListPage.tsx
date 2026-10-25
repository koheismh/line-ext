// アルバム一覧。個人＋所属グループのアルバムを表示し、新規作成できる。
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Album } from '@photo-album/shared';
import { api, ApiClientError } from '../services/api.js';
import { useSession } from '../store/session.js';

export function AlbumListPage() {
  const { userId } = useSession();
  const [albums, setAlbums] = useState<Album[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');

  async function refresh() {
    try {
      const res = await api.albums.list();
      setAlbums(res.albums);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '読み込みに失敗しました');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function create() {
    if (!title.trim() || !userId) return;
    await api.albums.create({ ownerType: 'user', ownerId: userId, title: title.trim() });
    setTitle('');
    await refresh();
  }

  return (
    <main>
      <h1>アルバム一覧</h1>
      {error && <p role="alert">{error}</p>}

      <section>
        <input
          aria-label="新しいアルバム名"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="新しいアルバム名"
        />
        <button type="button" onClick={() => void create()}>
          作成
        </button>
      </section>

      <ul>
        {albums.map((a) => (
          <li key={a.albumId}>
            <Link to={`/albums/${a.albumId}`}>{a.title}</Link>（{a.ownerType}）
          </li>
        ))}
      </ul>
    </main>
  );
}
