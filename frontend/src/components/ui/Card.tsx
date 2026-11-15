// カード（枠線と影のある面）。tone で背景色の役割を選ぶ。
import type { HTMLAttributes } from 'react';
import { cx } from './cx.js';
import styles from './Card.module.css';

export type CardTone = 'plain' | 'primary' | 'secondary' | 'accent' | 'info';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** 出力する要素（見出し付きのまとまりは section） */
  as?: 'div' | 'section' | 'article' | 'aside';
  tone?: CardTone;
  /** 内側の余白を広くする */
  roomy?: boolean;
}

export function Card({ as: Tag = 'div', tone = 'plain', roomy = false, className, ...rest }: CardProps) {
  return <Tag className={cx(styles.card, styles[tone], roomy && styles.roomy, className)} {...rest} />;
}

/** カードの見出し（絵文字付き）。 */
export function CardTitle({
  id,
  emoji,
  children,
}: {
  id?: string;
  emoji?: string;
  children: React.ReactNode;
}) {
  return (
    <h2 id={id} className={styles.title}>
      {emoji && (
        <span className={styles.emoji} aria-hidden="true">
          {emoji}
        </span>
      )}
      {children}
    </h2>
  );
}
