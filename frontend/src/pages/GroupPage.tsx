// グループページ。詳細・メンバー一覧・招待URL発行と有効な招待の失効（管理者のみ, 要件2-3/2-8/2-9）。
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Group, InviteSummary } from '@photo-album/shared';
import { api, errorMessage } from '../services/api.js';
import { useSession } from '../store/session.js';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
}

export function GroupPage() {
  const { groupId = '' } = useParams();
  const { userId } = useSession();
  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<{ userId: string; displayName: string }[]>([]);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
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
    } catch {
      // クリップボードが使えない環境では表示されたURLを手動でコピーしてもらう
    }
  }

  return (
    <main>
      <p>
        <Link to="/albums">← アルバム・グループ一覧</Link>
      </p>
      <h1>{group?.name ?? 'グループ'}</h1>
      {error && <p role="alert">{error}</p>}

      <section aria-labelledby="members">
        <h2 id="members">メンバー（{members.length}人）</h2>
        <ul>
          {members.map((m) => (
            <li key={m.userId}>
              {m.displayName}
              {group?.adminUserIds.includes(m.userId) && '（管理者）'}
            </li>
          ))}
        </ul>
      </section>

      {isAdmin && (
        <section aria-labelledby="invites">
          <h2 id="invites">招待</h2>
          <button type="button" onClick={() => void issue()}>
            招待URLを発行
          </button>
          {inviteUrl && (
            <p>
              このURLを招待したい人にだけ共有してください（7日間有効。URLは今だけ表示されます）:
              <br />
              <code style={{ wordBreak: 'break-all' }}>{inviteUrl}</code>{' '}
              <button type="button" onClick={() => void copy()}>
                コピー
              </button>
            </p>
          )}
          <h3>有効な招待</h3>
          {invites.length === 0 ? (
            <p>有効な招待はありません。</p>
          ) : (
            <ul>
              {invites.map((inv) => (
                <li key={inv.inviteId}>
                  発行: {formatDate(inv.createdAt)} / 期限: {formatDate(inv.expiresAt)}{' '}
                  <button type="button" onClick={() => void revoke(inv.inviteId)}>
                    失効させる
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
