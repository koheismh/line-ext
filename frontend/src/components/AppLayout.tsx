// ログイン後の共通レイアウト（ヘッダー・本文・フッター）。
import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { BRAND } from '../brand.js';
import { useSession } from '../store/session.js';
import { Button, cx } from './ui/index.js';
import styles from './AppLayout.module.css';

function navClassName({ isActive }: { isActive: boolean }): string {
  return cx(styles.navLink, isActive && styles.active);
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { displayName, logout } = useSession();
  const navigate = useNavigate();

  async function onLogout() {
    await logout();
    navigate('/', { replace: true });
  }

  return (
    <>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link to="/" className={styles.logo}>
            <span className={styles.logoMark} aria-hidden="true">
              {BRAND.logo}
            </span>
            <span>{BRAND.shortName}</span>
          </Link>
          <nav aria-label="メイン" className={styles.nav}>
            <NavLink to="/" end className={navClassName}>
              ホーム
            </NavLink>
            <NavLink to="/albums" className={navClassName}>
              アルバム
            </NavLink>
          </nav>
        </div>
      </header>

      {children}

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span>
            <strong>{displayName}</strong> さんでログイン中
          </span>
          <Button size="sm" variant="outline" onClick={() => void onLogout()}>
            ログアウト
          </Button>
        </div>
      </footer>
    </>
  );
}
