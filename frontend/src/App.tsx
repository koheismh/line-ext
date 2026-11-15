// ルーティング。未ログイン時はログイン画面（戻り先付き）、ログイン済みは共通レイアウトで各画面を表示する。
import { Routes, Route, Navigate } from 'react-router-dom';
import { useSession } from './store/session.js';
import { AppLayout } from './components/AppLayout.js';
import { Loading } from './components/ui/index.js';
import { LoginPage } from './pages/LoginPage.js';
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

/** 招待URL（/invite?token=）から開いた場合のトークン。ログイン開始時に引き継ぐ（要件1-13）。 */
function inviteTokenFromLocation(): string | null {
  if (window.location.pathname !== '/invite') return null;
  return new URLSearchParams(window.location.search).get('token');
}

function LoginGate({ children }: { children: React.ReactNode }) {
  const { userId, loading } = useSession();
  if (loading) return <Loading />;
  if (!userId) {
    return (
      <LoginPage
        returnTo={currentReturnTo()}
        loginError={new URLSearchParams(window.location.search).get('login_error')}
        inviteToken={inviteTokenFromLocation()}
      />
    );
  }
  return <>{children}</>;
}

export function App() {
  return (
    <LoginGate>
      <AppLayout>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/albums" element={<AlbumListPage />} />
          <Route path="/albums/:albumId" element={<AlbumDetailPage />} />
          <Route path="/groups/:groupId" element={<GroupPage />} />
          <Route path="/invite" element={<InvitePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppLayout>
    </LoginGate>
  );
}
