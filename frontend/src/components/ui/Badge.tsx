// 小さなラベル（「管理者」「処理中」など）。
import type { ReactNode } from 'react';
import { cx } from './cx.js';
import styles from './Badge.module.css';

export type BadgeTone = 'neutral' | 'primary' | 'secondary' | 'accent' | 'info' | 'danger';

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}) {
  return <span className={cx(styles.badge, styles[tone], className)}>{children}</span>;
}
