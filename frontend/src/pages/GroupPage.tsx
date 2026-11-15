// グループページ。メンバー一覧・招待URL発行と有効な招待の失効（管理者のみ, 要件2-3/2-8/2-9）。
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Group, InviteSummary } from '@photo-album/shared';
import { api, errorMessage } from '../services/api.js';
import { useSession } from '../store/session.js';
import { formatDateTime } from '../lib/format.js';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardTitle,
  EmptyState,
  Loading,
  Page,
} from '../components/ui/index.js';
import styles from './GroupPage.module.css';

export function GroupPage() {
  const { groupId = '' } = useParams();
  const { userId } = useSession();
  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<{ userId: string; displayName: string }[]>([]);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = !!group && !!userId && group.adminUserIds.includes(userId);

  const refresh = useCallback(async () => {
    try {
      const res = await api.groups.detail(groupId);
      setGroup(res.group);
      setMembers(res.members);
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
    >
      {error && <Alert tone="danger">{error}</Alert>}

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
    </Page>
  );
}
