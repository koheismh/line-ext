// 「まだ〜がありません」の表示。
import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';

export function EmptyState({
  emoji = '🫧',
  title,
  children,
}: {
  emoji?: string;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <span className={styles.emoji} aria-hidden="true">
        {emoji}
      </span>
      <p className={styles.title}>{title}</p>
      {children && <div className={styles.body}>{children}</div>}
    </div>
  );
}
