// 読み込み中の表示（はずむ3つの点）。
import styles from './Loading.module.css';

export function Loading({ label = '読み込み中' }: { label?: string }) {
  return (
    <div className={styles.loading} role="status">
      <span className={styles.dots} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{label}…</span>
    </div>
  );
}
