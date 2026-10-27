// セッションContext。ログイン状態（userId・表示名）を保持する。
// /api/me で解決。未ログインは null。

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../services/api.js';

interface SessionState {
  userId: string | null;
  displayName: string | null;
  loading: boolean;
  /** 再取得 */
  refresh: () => Promise<void>;
  /** ログアウト（サーバ側で sessionVersion を上げ、全Cookieを無効化する） */
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionState | undefined>(undefined);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const me = await api.me();
      setUserId(me.userId);
      setDisplayName(me.displayName);
    } catch {
      // 401 も通信失敗も未ログイン扱い（画面側でログイン導線を出す）
      setUserId(null);
      setDisplayName(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } finally {
      setUserId(null);
      setDisplayName(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <SessionContext.Provider value={{ userId, displayName, loading, refresh, logout }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
