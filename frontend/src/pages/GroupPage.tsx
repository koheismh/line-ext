// グループページ。グループは「メンバーの集まり」で、共有するアルバムはグループの中に作る。
// このグループのアルバム一覧と作成（メンバー, 要件2-9/3-1）、メンバー一覧、
// 招待URL発行と有効な招待の失効（管理者のみ, 要件2-3/2-8）、
// グループ名の変更と削除（管理者のみ。削除はアルバムが無いときだけ, 要件2-14/2-15）。
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ALBUM_TITLE_MAX_LENGTH,
  GROUP_NAME_MAX_LENGTH,
  type AlbumListItem,
  type Group,
  type InviteSummary,
} from '@photo-album/shared';
import { api, errorMessage } from '../services/api.js';
import { useSession } from '../store/session.js';
import { formatDateTime } from '../lib/format.js';
import { AlbumGrid } from '../components/AlbumGrid.js';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  Field,
  Loading,
  Page,
} from '../components/ui/index.js';
import styles from './GroupPage.module.css';

export function GroupPage() {
  const { groupId = '' } = useParams();
  const { userId } = useSession();
  const navigate = useNavigate();
  const [group, setGroup] = useState<Group | null>(null);
  /** 編集中のグループ名。null は未編集（いまの名前を表示する）。 */
  const [newName, setNewName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [members, setMembers] = useState<{ userId: string; displayName: string }[]>([]);
  const [albums, setAlbums] = useState<AlbumListItem[]>([]);
  const [albumTitle, setAlbumTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = !!group && !!userId && group.adminUserIds.includes(userId);

  const refresh = useCallback(async () => {
    try {
      const [res, list] = await Promise.all([
        api.groups.detail(groupId),
        api.albums.list(groupId),
      ]);
      setGroup(res.group);
      setMembers(res.members);
      setAlbums(list.albums);
      setError(null);
      if (userId && res.group.adminUserIds.includes(userId)) {
        setInvites((await api.groups.invites(groupId)).invites);
      }
    } catch (err) {
      setError(errorMessage(err, '読み込みに失敗しました。'));
    }
  }, [groupId, userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** このグループにアルバムを作る（所有主体はこのグループ。認可はサーバが正本で判定する）。 */
  async function createAlbum(e: React.FormEvent) {
    e.preventDefault();
    const title = albumTitle.trim();
    if (!title) return;
    setCreating(true);
    try {
      await api.albums.create({ ownerType: 'group', ownerId: groupId, title });
      setAlbumTitle('');
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  /** グループ名を変える（管理者のみ。権限と名前の検証はサーバが行う）。 */
  async function rename(e: React.FormEvent) {
    e.preventDefault();
    if (!group) return;
    const name = (newName ?? group.name).trim();
    if (!name || name === group.name) return;
    setRenaming(true);
    try {
      const updated = await api.groups.rename(groupId, name);
      setGroup(updated);
      setNewName(null);
      setNotice('グループ名を変更しました。');
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRenaming(false);
    }
  }

  /** グループを削除する（管理者のみ。アルバムがあるグループはサーバが拒否する）。 */
  async function remove() {
    if (!group) return;
    if (
      !confirm(
        `グループ「${group.name}」を削除しますか？ メンバー全員がこのグループを見られなくなり、招待URLも使えなくなります。`,
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      await api.groups.remove(groupId);
      navigate('/albums', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setDeleting(false);
    }
  }

  async function issue() {
    try {
      const res = await api.groups.issueInvite(groupId);
      // 招待URL（LINEで開かれたときに外部ブラウザへ誘導するため openExternalBrowser=1 を付与, 要件10-2）
      const base = `${window.location.origin}/invite?token=${encodeURIComponent(res.token)}`;
      setInviteUrl(`${base}&openExternalBrowser=1`);
      setCopied(false);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function revoke(inviteId: string) {
    if (!confirm('この招待を失効させますか？ 失効後はこの招待URLで参加できなくなります。')) return;
    try {
      await api.groups.revokeInvite(inviteId);
      setInviteUrl(null);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copy() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
    } catch {
      // クリップボードが使えない環境では、表示されたURLを手動でコピーしてもらう
    }
  }

  if (!group && !error) return <Loading />;

  return (
    <Page
      title={group?.name ?? 'グループ'}
      emoji="👥"
      back={{ to: '/albums', label: 'アルバム・グループ一覧' }}
      lead={
        group
          ? `メンバー${members.length}人のグループです。このグループのアルバムは、メンバー全員が見たり写真・動画を追加したりできます。`
          : undefined
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {group && (
        <section aria-labelledby="group-albums" className={styles.section}>
          <h2 id="group-albums" className={styles.sectionTitle}>
            <span aria-hidden="true">📚</span> このグループのアルバム
          </h2>
          {albums.length === 0 ? (
            <EmptyState emoji="🌱" title="まだアルバムがありません">
              下の「アルバムを作る」から作ると、メンバーみんなで見られます。
            </EmptyState>
          ) : (
            <AlbumGrid albums={albums} />
          )}
        </section>
      )}

      {group && (
        <Card as="section" tone="primary" aria-labelledby="create-group-album">
          <CardTitle id="create-group-album" emoji="✨">
            アルバムを作る
          </CardTitle>
          <form className={styles.form} onSubmit={(e) => void createAlbum(e)}>
            <Field label="アルバム名" className={styles.grow}>
              <input
                value={albumTitle}
                onChange={(e) => setAlbumTitle(e.target.value)}
                maxLength={ALBUM_TITLE_MAX_LENGTH}
                placeholder="例: 夏の旅行"
                required
              />
            </Field>
            <Button type="submit" variant="primary" disabled={creating} className={styles.submit}>
              作成する
            </Button>
          </form>
        </Card>
      )}

      {group && (
        <Card as="section" aria-labelledby="members">
          <CardTitle id="members" emoji="🙌">
            メンバー <Badge>{members.length}人</Badge>
          </CardTitle>
          <ul className={styles.members}>
            {members.map((m) => (
              <li key={m.userId} className={styles.member}>
                <Avatar name={m.displayName} seed={m.userId} />
                <span className={styles.memberName}>{m.displayName}</span>
                {group.adminUserIds.includes(m.userId) && <Badge tone="secondary">管理者</Badge>}
                {m.userId === userId && <Badge tone="info">自分</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {isAdmin && (
        <Card as="section" tone="accent" aria-labelledby="invites">
          <CardTitle id="invites" emoji="💌">
            招待
          </CardTitle>
          <p className={styles.muted}>
            招待URLを LINE などで送ると、受け取った人がログインしてこのグループに参加できます（7日間有効）。
          </p>
          <Button variant="primary" icon="✉️" onClick={() => void issue()}>
            招待URLを発行
          </Button>

          {inviteUrl && (
            <div className={styles.inviteBox}>
              <p className={styles.inviteNote}>
                このURLを招待したい人にだけ送ってください。URLは今だけ表示されます。
              </p>
              <code className={styles.inviteUrl}>{inviteUrl}</code>
              <Button size="sm" variant="secondary" icon={copied ? '✅' : '📋'} onClick={() => void copy()}>
                {copied ? 'コピーしました' : 'コピー'}
              </Button>
            </div>
          )}

          <h3 className={styles.subTitle}>有効な招待</h3>
          {invites.length === 0 ? (
            <EmptyState emoji="📭" title="有効な招待はありません" />
          ) : (
            <ul className={styles.invites}>
              {invites.map((inv) => (
                <li key={inv.inviteId} className={styles.invite}>
                  <span className={styles.inviteDates}>
                    <span>発行: {formatDateTime(inv.createdAt)}</span>
                    <span>期限: {formatDateTime(inv.expiresAt)}</span>
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void revoke(inv.inviteId)}>
                    失効させる
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {isAdmin && group && (
        <Card as="section" aria-labelledby="group-settings">
          <CardTitle id="group-settings" emoji="⚙️">
            グループの設定
          </CardTitle>
          <form className={styles.form} onSubmit={(e) => void rename(e)}>
            <Field label="グループ名" hint={`${GROUP_NAME_MAX_LENGTH}文字以内`} className={styles.grow}>
              <input
                value={newName ?? group.name}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={GROUP_NAME_MAX_LENGTH}
                required
              />
            </Field>
            <Button
              type="submit"
              disabled={
                renaming ||
                !(newName ?? group.name).trim() ||
                (newName ?? group.name).trim() === group.name
              }
              className={styles.submit}
            >
              名前を変える
            </Button>
          </form>

          <h3 className={styles.subTitle}>グループの削除</h3>
          <p className={styles.muted}>
            {albums.length > 0
              ? 'アルバムがあるグループは削除できません（アルバムを消す機能はまだありません）。'
              : '削除すると、メンバー全員がこのグループを見られなくなり、招待URLも使えなくなります。'}
          </p>
          <Button
            variant="danger"
            icon="🗑"
            disabled={deleting || albums.length > 0}
            onClick={() => void remove()}
          >
            グループを削除
          </Button>
        </Card>
      )}
    </Page>
  );
}
