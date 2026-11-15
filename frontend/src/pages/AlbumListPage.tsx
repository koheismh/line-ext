// アルバム・グループ一覧。所有主体（個人／各グループ）別にアルバムを表紙付きで表示し、
// アルバム（個人用／グループ用）とグループを作成できる。
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { GROUP_NAME_MAX_LENGTH, type AlbumListItem, type GroupSummary } from '@photo-album/shared';
import { api, errorMessage } from '../services/api.js';
import { useSession } from '../store/session.js';
import { AlbumGrid } from '../components/AlbumGrid.js';
import {
  Alert,
  Button,
  Card,
  CardTitle,
  EmptyState,
  Field,
  Page,
  buttonClassName,
} from '../components/ui/index.js';
import styles from './AlbumListPage.module.css';

const PERSONAL = 'user';

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
    <Page title="アルバム" emoji="📚">
      {error && <Alert tone="danger">{error}</Alert>}

      <Card as="section" tone="primary" aria-labelledby="create-album">
        <CardTitle id="create-album" emoji="✨">
          新しいアルバム
        </CardTitle>
        <form className={styles.form} onSubmit={(e) => void createAlbum(e)}>
          <Field label="アルバム名" className={styles.grow}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              placeholder="例: 夏の旅行"
              required
            />
          </Field>
          <Field label="保存先" className={styles.grow}>
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value={PERSONAL}>自分だけ（個人）</option>
              {groups.map((g) => (
                <option key={g.groupId} value={g.groupId}>
                  グループ「{g.name}」
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" variant="primary" disabled={busy} className={styles.submit}>
            作成する
          </Button>
        </form>
      </Card>

      <section aria-labelledby="personal-albums" className={styles.section}>
        <h2 id="personal-albums" className={styles.sectionTitle}>
          <span aria-hidden="true">🔒</span> 自分だけのアルバム
        </h2>
        {personal.length === 0 ? (
          <EmptyState emoji="🖼️" title="まだアルバムがありません">
            上の「新しいアルバム」から作れます。
          </EmptyState>
        ) : (
          <AlbumGrid albums={personal} />
        )}
      </section>

      {groups.map((g) => {
        const own = albums.filter((a) => a.ownerType === 'group' && a.ownerId === g.groupId);
        const headingId = `group-${g.groupId}`;
        return (
          <section key={g.groupId} aria-labelledby={headingId} className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2 id={headingId} className={styles.sectionTitle}>
                <span aria-hidden="true">👥</span> {g.name}
              </h2>
              <Link
                to={`/groups/${encodeURIComponent(g.groupId)}`}
                className={buttonClassName({ size: 'sm' })}
              >
                メンバー・招待
              </Link>
            </div>
            {own.length === 0 ? (
              <EmptyState emoji="🌱" title="まだアルバムがありません">
                「新しいアルバム」の保存先にこのグループを選ぶと、メンバーみんなで見られます。
              </EmptyState>
            ) : (
              <AlbumGrid albums={own} />
            )}
          </section>
        );
      })}

      <Card as="section" tone="accent" aria-labelledby="create-group">
        <CardTitle id="create-group" emoji="🎈">
          グループを作る
        </CardTitle>
        <p className={styles.muted}>
          家族や友だちと共有するためのグループです。作成後、「メンバー・招待」から招待URLを発行できます。
        </p>
        <form className={styles.form} onSubmit={(e) => void createGroup(e)}>
          <Field label="グループ名" hint={`${GROUP_NAME_MAX_LENGTH}文字以内`} className={styles.grow}>
            <input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              maxLength={GROUP_NAME_MAX_LENGTH}
              placeholder="例: 山田家"
              required
            />
          </Field>
          <Button type="submit" variant="secondary" disabled={busy} className={styles.submit}>
            作成する
          </Button>
        </form>
      </Card>
    </Page>
  );
}
