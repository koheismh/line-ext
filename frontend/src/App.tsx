// ルーティング。未ログイン時はログイン導線（戻り先付き）。ログイン済みはヘッダ（ナビ・ログアウト）を表示する。
import { Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom';
import { useSession } from './store/session.js';
import { HomePage } from './pages/HomePage.js';
import { AlbumListPage } from './pages/AlbumListPage.js';
import { AlbumDetailPage } from './pages/AlbumDetailPage.js';
import { GroupPage } from './pages/GroupPage.js';
import { InvitePage } from './pages/InvitePage.js';

/** 現在の URL から login_error を除いた戻り先（同一オリジンの相対パス）。 */
function currentReturnTo(): string {
  const params = new URLSearchParams(window.location.search);
  params.delete('login_error');
  const query = params.toString();
  return window.location.pathname + (query ? `?${query}` : '');
}

function LoginGate({ children }: { children: React.ReactNode }) {
  const { userId, loading } = useSession();
  if (loading) return <p role="status">読み込み中...</p>;
  if (!userId) {
    const loginError = new URLSearchParams(window.location.search).has('login_error');
    const returnTo = encodeURIComponent(currentReturnTo());
    return (
      <main>
        <h1>写真・動画共有アルバム</h1>
        {loginError && (
          <p role="alert">
            ログインできませんでした（キャンセルされたか、エラーが発生しました）。もう一度お試しください。
          </p>
        )}
        <p>ご利用にはLINEログインが必要です。</p>
        <a href={`/api/auth/line/start?returnTo=${returnTo}`}>LINEでログイン</a>
      </main>
    );
  }
  return <>{children}</>;
}

function Header() {
  const { displayName, logout } = useSession();
  const navigate = useNavigate();
  async function onLogout() {
    await logout();
    navigate('/', { replace: true });
  }
  return (
    <header style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <nav aria-label="メイン" style={{ display: 'flex', gap: 12 }}>
        <Link to="/">ホーム</Link>
        <Link to="/albums">アルバム・グループ</Link>
      </nav>
      <span style={{ marginLeft: 'auto' }}>{displayName}</span>
      <button type="button" onClick={() => void onLogout()}>
        ログアウト
      </button>
    </header>
  );
}

export function App() {
  return (
    <LoginGate>
      <Header />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/albums" element={<AlbumListPage />} />
        <Route path="/albums/:albumId" element={<AlbumDetailPage />} />
        <Route path="/groups/:groupId" element={<GroupPage />} />
        <Route path="/invite" element={<InvitePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </LoginGate>
  );
}
