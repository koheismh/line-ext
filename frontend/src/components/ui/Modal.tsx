// モーダル（ブラウザ標準の <dialog> を使用）。
// showModal() により、背面の操作不可・フォーカスの閉じ込め・Esc で閉じる、をブラウザに任せる。
// Esc などで閉じられたときは onClose で親に伝える（表示状態は親の open が正）。
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cx } from './cx.js';
import styles from './Modal.module.css';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** 下部の操作ボタン */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** 背景（モーダルの外側）を押したら閉じるか */
  closeOnBackdrop?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  closeOnBackdrop = true,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // ブラウザ側のイベント（非同期）から最新の値を参照するため
  const openRef = useRef(open);
  const onCloseRef = useRef(onClose);
  openRef.current = open;
  onCloseRef.current = onClose;
  const pressedOnBackdrop = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', ''); // 古い環境・テスト環境向け
    }
    document.documentElement.classList.add('has-modal');
    return () => {
      document.documentElement.classList.remove('has-modal');
      if (dialog.open) {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
      }
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx(styles.dialog, styles[size])}
      aria-labelledby={titleId}
      // Esc 等でブラウザが閉じた場合だけ親に伝える。
      // - 親が閉じた場合は open=false なので呼ばない
      // - close イベントは後から届くため、その時点で開き直していれば（開発時の StrictMode の再実行など）無視する
      onClose={() => {
        if (openRef.current && !ref.current?.open) onCloseRef.current();
      }}
      onPointerDown={(e) => {
        pressedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (closeOnBackdrop && pressedOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.panel}>
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="閉じる">
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </dialog>
  );
}
