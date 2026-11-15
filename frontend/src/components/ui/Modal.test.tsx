import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Modal } from './Modal.js';
import { Button } from './Button.js';

// jsdom の <dialog> は showModal()/close() を持たないため、Modal の代替処理（open 属性の付け外し）で検証する。

describe('Modal', () => {
  it('開くと dialog が開き、背面のスクロールを止める。閉じると元に戻す', () => {
    const { rerender } = render(
      <Modal open onClose={() => {}} title="タイトル">
        本文
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(document.documentElement.classList.contains('has-modal')).toBe(true);

    rerender(
      <Modal open={false} onClose={() => {}} title="タイトル">
        本文
      </Modal>,
    );
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(document.documentElement.classList.contains('has-modal')).toBe(false);
  });

  it('閉じるボタンで onClose を呼ぶ', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="タイトル">
        本文
      </Modal>,
    );
    fireEvent.click(screen.getByRole('button', { name: '閉じる', hidden: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ブラウザが閉じた（Esc など）ときだけ onClose を呼び、開いたままの close イベントは無視する', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="タイトル">
        本文
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { hidden: true }) as HTMLDialogElement;

    // 開き直した後に古い close イベントが届いた場合（開発時の StrictMode など）は閉じない
    fireEvent(dialog, new Event('close'));
    expect(onClose).not.toHaveBeenCalled();

    // Esc でブラウザが閉じた場合は親に伝える
    dialog.removeAttribute('open');
    fireEvent(dialog, new Event('close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closeOnBackdrop=false なら外側を押しても閉じない', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="確認" closeOnBackdrop={false}>
        本文
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { hidden: true });
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('Button', () => {
  it('既定は type="button"（フォーム内で誤って送信しない）。絵文字は読み上げない', () => {
    render(<Button icon="⭐">表紙にする</Button>);
    const button = screen.getByRole('button', { name: '表紙にする' });
    expect(button.getAttribute('type')).toBe('button');
  });
});
