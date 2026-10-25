// グループページ。詳細・メンバー一覧・招待URL発行/失効。
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Group } from '@photo-album/shared';
import { api, ApiClientError } from '../services/api.js';

export function GroupPage() {
  const { groupId = '' } = useParams();
  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<{ userId: string; displayName: string }[]>([]);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.groups.detail(groupId);
      setGroup(res.group);
      setMembers(res.members);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '読み込みに失敗しました');
    }
  }, [groupId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function issue() {
    const res = await api.groups.issueInvite(groupId);
    // 招待URL（外部ブラウザ誘導のため openExternalBrowser=1 を付与）
    const base = `${window.location.origin}/invite?token=${encodeURIComponent(res.token)}`;
    setInviteUrl(`${base}&openExternalBrowser=1`);
  }

  return (
    <main>
      <h1>{group?.name ?? 'グループ'}</h1>
      {error && <p role="alert">{error}</p>}

      <section>
        <h2>メンバー</h2>
        <ul>
          {members.map((m) => (
            <li key={m.userId}>{m.displayName}</li>
          ))}
        </ul>
      </section>

      <section>
        <h2>招待</h2>
        <button type="button" onClick={() => void issue()}>
          招待URLを発行
        </button>
        {inviteUrl && (
          <p>
            このURLを共有してください（7日間有効）:
            <br />
            <code>{inviteUrl}</code>
          </p>
        )}
      </section>
    </main>
  );
}
