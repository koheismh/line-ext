// 名前の頭文字を丸く表示するアバター。色は seed（userId）ごとに固定。
// 名前は隣に文字で表示する前提のため、読み上げ対象外にしている。
import { initialOf } from '../../lib/format.js';
import { cx } from './cx.js';
import { decoClassName } from './deco.js';
import styles from './Avatar.module.css';

export function Avatar({ name, seed, size = 'md' }: { name: string; seed: string; size?: 'sm' | 'md' }) {
  return (
    <span className={cx(styles.avatar, decoClassName(seed), size === 'sm' && styles.sm)} aria-hidden="true">
      {initialOf(name)}
    </span>
  );
}
