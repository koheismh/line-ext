// 招待受け入れ画面。URLのtokenを読み、明示操作で参加する（開くだけでは参加しない）。
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../services/api.js';
import { Alert, Button, Card } from '../components/ui/index.js';
import styles from './InvitePage.module.css';

export function InvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  async function join() {
    if (!token) {
      setError('招待トークンがありません。招待URLをもう一度開いてください。');
      return;
    }
    setJoining(true);
    try {
      const res = await api.groups.acceptInvite(token);
      navigate(`/groups/${encodeURIComponent(res.groupId)}`);
    } catch (err) {
      setError(errorMessage(err, '参加に失敗しました。'));
      setJoining(false);
    }
  }

  return (
    <main className={styles.page}>
      <Card roomy tone="primary" className={styles.card}>
        <span className={styles.emoji} aria-hidden="true">
          🎉
        </span>
        <h1 className={styles.title}>グループへの招待</h1>
        <p className={styles.text}>
          招待されたグループに参加しますか？
          <br />
          参加すると、グループのアルバムを見たり、写真や動画を追加したりできます。
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button variant="secondary" size="lg" block disabled={joining} onClick={() => void join()}>
          {joining ? '参加しています…' : '参加する'}
        </Button>
      </Card>
    </main>
  );
}
