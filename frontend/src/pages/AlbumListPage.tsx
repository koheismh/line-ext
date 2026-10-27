// アルバム・グループ一覧。所有主体（個人／各グループ）別にアルバムを表紙付きで表示し、
// アルバム（個人用／グループ用）とグループを作成できる。
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AlbumListItem, GroupSummary } from '@photo-album/shared';
import { api, errorMessage } from '../services/api.js';
import { useSession } from '../store/session.js';

const PERSONAL = 'user';

function AlbumCard({ album }: { album: AlbumListItem }) {
  return (
    <li>
      <Link to={`/albums/${encodeURIComponent(album.albumId)}`} style={{ display: 'inline-block', width: 140 }}>
        {album.coverPreviewUrl ? (
          <img
            src={album.coverPreviewUrl}
            alt=""
            width={140}
            height={140}
            loading="lazy"
            style={{ objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <span
            aria-hidden="true"
            style={{ display: 'block', width: 140, height: 140, background: '#ddd' }}
          />
        )}
        <span>{album.title}</span>
      </Link>
    </li>
  );
}

const gridStyle = { display: 'flex', flexWrap: 'wrap', gap: 12, listStyle: 'none', padding: 0 } as const;

export function AlbumListPage() {
  const { userId } = useSession();
  const [albums, setAlbums] = useState<AlbumListItem[]>([]);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState<string>(PERSONAL);
  const [groupName, setGroupName] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [a, g] = await Promise.all([api.albums.list(), api.groups.list()]);
      setAlbums(a.albums);
      setGroups(g.groups);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, '読み込みに失敗しました。'));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createAlbum(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !userId) return;
    setBusy(true);
    try {
      await api.albums.create(
        owner === PERSONAL
          ? { ownerType: 'user', ownerId: userId, title: title.trim() }
          : { ownerType: 'group', ownerId: owner, title: title.trim() },
      );
      setTitle('');
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function createGroup(e: React.FormEvent) {
    e.preventDefault();
    if (!groupName.trim()) return;
    setBusy(true);
    try {
      await api.groups.create(groupName.trim());
      setGroupName('');
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const personal = albums.filter((a) => a.ownerType === 'user');

  return (
    <main>
      <h1>アルバム</h1>
      {error && <p role="alert">{error}</p>}

      <form onSubmit={(e) => void createAlbum(e)} aria-label="アルバムを作成">
        <label>
          新しいアルバム名{' '}
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} required />
        </label>{' '}
        <label>
          保存先{' '}
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value={PERSONAL}>自分だけ（個人）</option>
            {groups.map((g) => (
              <option key={g.groupId} value={g.groupId}>
                グループ「{g.name}」
              </option>
            ))}
          </select>
        </label>{' '}
        <button type="submit" disabled={busy}>
          作成
        </button>
      </form>

      <section aria-labelledby="personal-albums">
        <h2 id="personal-albums">個人のアルバム</h2>
        {personal.length === 0 ? (
          <p>まだありません。</p>
        ) : (
          <ul style={gridStyle}>
            {personal.map((a) => (
              <AlbumCard key={a.albumId} album={a} />
            ))}
          </ul>
        )}
      </section>

      {groups.map((g) => {
        const own = albums.filter((a) => a.ownerType === 'group' && a.ownerId === g.groupId);
        return (
          <section key={g.groupId} aria-labelledby={`group-${g.groupId}`}>
            <h2 id={`group-${g.groupId}`}>
              グループ「{g.name}」のアルバム{' '}
              <Link to={`/groups/${encodeURIComponent(g.groupId)}`} style={{ fontSize: '0.8em' }}>
                メンバー・招待
              </Link>
            </h2>
            {own.length === 0 ? (
              <p>まだありません。</p>
            ) : (
              <ul style={gridStyle}>
                {own.map((a) => (
                  <AlbumCard key={a.albumId} album={a} />
                ))}
              </ul>
            )}
          </section>
        );
      })}

      <section aria-labelledby="create-group">
        <h2 id="create-group">グループを作る</h2>
        <form onSubmit={(e) => void createGroup(e)}>
          <label>
            グループ名（50文字以内）{' '}
            <input value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={50} required />
          </label>{' '}
          <button type="submit" disabled={busy}>
            作成
          </button>
        </form>
        <p>作成したグループの「メンバー・招待」から招待URLを発行して、家族や友人を招待できます。</p>
      </section>
    </main>
  );
}
