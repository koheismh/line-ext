// ボタン。見た目は variant（色の役割）と size で選ぶ。
// リンク（<a> や react-router の <Link>）をボタンの見た目にするときは buttonClassName() を使う。
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx.js';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'line';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonStyleOptions {
  /** primary=メイン操作 / secondary=サブ操作 / outline=通常 / ghost=控えめ / danger=削除など / line=LINEログイン */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 横幅いっぱいにする */
  block?: boolean;
}

/** ボタンの見た目のクラス名。 */
export function buttonClassName(
  { variant = 'outline', size = 'md', block = false }: ButtonStyleOptions = {},
  extra?: string,
): string {
  return cx(styles.button, styles[variant], styles[size], block && styles.block, extra);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyleOptions {
  /** 文字の前に表示する絵文字（読み上げ対象外） */
  icon?: ReactNode;
}

export function Button({
  variant,
  size,
  block,
  icon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button type={type} className={buttonClassName({ variant, size, block }, className)} {...rest}>
      {icon !== undefined && <ButtonIcon>{icon}</ButtonIcon>}
      {children}
    </button>
  );
}

/** ボタン内の絵文字（リンクをボタンの見た目にした場合にも使う）。 */
export function ButtonIcon({ children }: { children: ReactNode }) {
  return (
    <span className={styles.icon} aria-hidden="true">
      {children}
    </span>
  );
}
