// 画面の共通レイアウト（戻るリンク・見出し・操作ボタン・本文）。各ページはこれで包む。
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import styles from './Page.module.css';

export interface PageProps {
  title: ReactNode;
  /** 見出しの前の絵文字 */
  emoji?: string;
  /** 戻り先 */
  back?: { to: string; label: string };
  /** 見出しの右側に置く操作 */
  actions?: ReactNode;
  /** 見出しの下の説明文 */
  lead?: ReactNode;
  children: ReactNode;
}

export function Page({ title, emoji, back, actions, lead, children }: PageProps) {
  return (
    <main className={styles.page}>
      {back && (
        <Link to={back.to} className={styles.back}>
          <span aria-hidden="true">←</span>
          {back.label}
        </Link>
      )}
      <div className={styles.header}>
        <h1 className={styles.title}>
          {emoji && (
            <span className={styles.emoji} aria-hidden="true">
              {emoji}
            </span>
          )}
          <span className={styles.marker}>{title}</span>
        </h1>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      {lead && <div className={styles.lead}>{lead}</div>}
      <div className={styles.content}>{children}</div>
    </main>
  );
}
