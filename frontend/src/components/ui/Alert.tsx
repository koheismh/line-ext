// お知らせ・エラー表示。tone で色と絵文字が決まる。
// role の既定: danger=alert（すぐ読み上げ）/ それ以外=status。動かない案内文は role="note" を指定する。
import type { ReactNode } from 'react';
import { cx } from './cx.js';
import styles from './Alert.module.css';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const ICONS: Record<AlertTone, string> = {
  info: '💡',
  success: '🎉',
  warning: '⚠️',
  danger: '😢',
};

export interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  /** 先頭の絵文字を変える */
  icon?: string;
  role?: 'alert' | 'status' | 'note';
  className?: string;
  children?: ReactNode;
}

export function Alert({ tone = 'info', title, icon, role, className, children }: AlertProps) {
  return (
    <div
      role={role ?? (tone === 'danger' ? 'alert' : 'status')}
      className={cx(styles.alert, styles[tone], className)}
    >
      <span className={styles.icon} aria-hidden="true">
        {icon ?? ICONS[tone]}
      </span>
      <div className={styles.content}>
        {title && <strong className={styles.title}>{title}</strong>}
        {children}
      </div>
    </div>
  );
}
