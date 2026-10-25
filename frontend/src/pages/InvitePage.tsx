// 招待受け入れ画面。URLのtokenを読み、明示操作で参加する（開くだけでは参加しない）。
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiClientError } from '../services/api.js';

export function InvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  async function join() {
    if (!token) {
      setError('招待トークンがありません。');
      return;
    }
    setJoining(true);
    try {
      const res = await api.groups.acceptInvite(token);
      navigate(`/groups/${res.groupId}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '参加に失敗しました');
      setJoining(false);
    }
  }

  return (
    <main>
      <h1>グループへの招待</h1>
      {error && <p role="alert">{error}</p>}
      <p>このグループに参加しますか？</p>
      <button type="button" disabled={joining} onClick={() => void join()}>
        参加する
      </button>
    </main>
  );
}
