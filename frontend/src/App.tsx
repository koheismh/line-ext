// ルーティング。未ログイン時はログイン導線（戻り先付き）。
import { Routes, Route, Navigate } from 'react-router-dom';
import { useSession } from './store/session.js';
import { HomePage } from './pages/HomePage.js';
import { AlbumListPage } from './pages/AlbumListPage.js';
import { AlbumDetailPage } from './pages/AlbumDetailPage.js';
import { GroupPage } from './pages/GroupPage.js';
import { InvitePage } from './pages/InvitePage.js';

function LoginGate({ children }: { children: React.ReactNode }) {
  const { userId, loading } = useSession();
  if (loading) return <p>読み込み中...</p>;
  if (!userId) {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    return (
      <main>
        <h1>写真・動画共有アルバム</h1>
        <p>ご利用にはLINEログインが必要です。</p>
        <a href={`/api/auth/line/start?returnTo=${returnTo}`}>LINEでログイン</a>
      </main>
    );
  }
  return <>{children}</>;
}

export function App() {
  return (
    <LoginGate>
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
