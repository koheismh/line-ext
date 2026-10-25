// セッションContext。ログイン状態（userId）を保持する。
// /api/me で解決。未ログインは null。

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiClientError } from '../services/api.js';

interface SessionState {
  userId: string | null;
  loading: boolean;
  /** 再取得 */
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionState | undefined>(undefined);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      const me = await api.me();
      setUserId(me.userId);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        setUserId(null);
      }
      // その他のエラーは未ログイン扱いにして画面側で再試行
      else setUserId(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <SessionContext.Provider value={{ userId, loading, refresh }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
