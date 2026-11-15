// 入力欄の見出し（label）と補足説明。入力欄そのものの見た目は styles/base.css で決めている。
import type { ReactNode } from 'react';
import { cx } from './cx.js';
import styles from './Field.module.css';

export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  /** input / select / textarea */
  children: ReactNode;
}) {
  return (
    <label className={cx(styles.field, className)}>
      <span className={styles.label}>{label}</span>
      {children}
      {hint && <span className={styles.hint}>{hint}</span>}
    </label>
  );
}
