// アルバム・グループ一覧。アルバムは必ず「自分だけ」か「グループ」のどちらかに属する。
// 所有主体（個人／各グループ）別にアルバムを表紙付きで表示し、アルバムとグループを作成できる。
// 他の人と共有するアルバムはグループの中に作る。アルバム作成時に新しいグループも作れるが、
// それも通常のグループと同じもの（アルバム専用の特別なグループは作らない）。
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ALBUM_TITLE_MAX_LENGTH,
  GROUP_NAME_MAX_LENGTH,
  type AlbumListItem,
  type GroupSummary,
  type OwnerType,
} from '@photo-album/shared';
import { api, errorMessage } from '../services/api.js';
import { useSession } from '../store/session.js';
import { AlbumGrid } from '../components/AlbumGrid.js';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  Field,
  Page,
  buttonClassName,
} from '../components/ui/index.js';
import styles from './AlbumListPage.module.css';

/** 保存先の選択肢: 自分だけ */
const PERSONAL = 'user';
/** 保存先の選択肢: 新しいグループを作ってその中に作る（グループIDと衝突しない値） */
const NEW_GROUP = 'new-group';

/** 保存先ごとの補足説明（だれが見られるか）。 */
function ownerHint(owner: string): string {
  if (owner === PERSONAL) {
    return 'あなただけが見られます。ほかの人と共有するときは、グループを選ぶか新しく作ってください。';
  }
  if (owner === NEW_GROUP) {
    return 'グループを作り、その中にアルバムを作ります。グループの画面から招待URLを発行してメンバーを招待できます。';
  }
  return 'このグループのメンバー全員が見られます。';
}

export function AlbumListPage() {
  const { userId } = useSession();
  const navigate = useNavigate();
  const [albums, setAlbums] = useState<AlbumListItem[]>([]);
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState<string>(PERSONAL);
  const [newGroupName, setNewGroupName] = useState('');
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
    const albumTitle = title.trim();
    const name = newGroupName.trim();
    if (!albumTitle || !userId) return;
    if (owner === NEW_GROUP && !name) return;
    setBusy(true);
    let createdGroupId: string | null = null;
    try {
      let target: { ownerType: OwnerType; ownerId: string };
      if (owner === NEW_GROUP) {
        // 通常のグループを作り、その中にアルバムを作る
        const group = await api.groups.create(name);
        createdGroupId = group.groupId;
        target = { ownerType: 'group', ownerId: group.groupId };
      } else if (owner === PERSONAL) {
        target = { ownerType: 'user', ownerId: userId };
      } else {
        target = { ownerType: 'group', ownerId: owner };
      }
      await api.albums.create({ ...target, title: albumTitle });
      if (createdGroupId) {
        // 次はメンバーの招待。アルバム・メンバー・招待がそろうグループの画面へ移る
        navigate(`/groups/${encodeURIComponent(createdGroupId)}`);
        return;
      }
      setTitle('');
      await refresh();
    } catch (err) {
      if (createdGroupId) {
        // グループだけ作れた場合は、再試行でグループを二重に作らないよう保存先をそのグループに切り替える
        setOwner(createdGroupId);
        setNewGroupName('');
        await refresh();
      }
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
              maxLength={ALBUM_TITLE_MAX_LENGTH}
              placeholder="例: 夏の旅行"
              required
            />
          </Field>
          <Field label="保存先" hint={ownerHint(owner)} className={styles.grow}>
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value={PERSONAL}>自分だけ（ほかの人には見えません）</option>
              {groups.map((g) => (
                <option key={g.groupId} value={g.groupId}>
                  グループ「{g.name}」（{g.memberCount}人）
                </option>
              ))}
              <option value={NEW_GROUP}>＋ 新しいグループを作って共有する</option>
            </select>
          </Field>
          {owner === NEW_GROUP && (
            <Field
              label="新しいグループの名前"
              hint={`${GROUP_NAME_MAX_LENGTH}文字以内`}
              className={styles.grow}
            >
              <input
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                maxLength={GROUP_NAME_MAX_LENGTH}
                placeholder="例: 山田家"
                required
              />
            </Field>
          )}
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
                <span aria-hidden="true">👥</span> {g.name} <Badge>{g.memberCount}人</Badge>
              </h2>
              <Link
                to={`/groups/${encodeURIComponent(g.groupId)}`}
                className={buttonClassName({ size: 'sm' })}
              >
                グループを開く
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
          家族や友だちと共有するためのグループです。グループの中に作ったアルバムは、メンバー全員で見られます。メンバーの招待はグループの画面（「グループを開く」）から行えます。
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
