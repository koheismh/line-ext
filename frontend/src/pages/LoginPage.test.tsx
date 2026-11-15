import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoginPage, loginStartUrl } from './LoginPage.js';

describe('loginStartUrl', () => {
  it('戻り先を付け、招待トークンがあれば invite として引き継ぐ（新規登録は招待が必要）', () => {
    expect(loginStartUrl('/invite?token=a b', 'a b')).toBe(
      '/api/auth/line/start?returnTo=%2Finvite%3Ftoken%3Da%20b&invite=a%20b',
    );
    expect(loginStartUrl('/albums', null)).toBe('/api/auth/line/start?returnTo=%2Falbums');
  });
});

describe('LoginPage', () => {
  it('login_error の理由ごとに説明を出す', () => {
    render(<LoginPage returnTo="/" loginError="invite_used" inviteToken={null} />);
    expect(screen.getByRole('alert').textContent).toContain('この招待はすでに使用されています');
  });

  it('理由が分からないエラーは既定の説明を出す', () => {
    render(<LoginPage returnTo="/" loginError="1" inviteToken={null} />);
    expect(screen.getByRole('alert').textContent).toContain('もう一度お試しください');
  });

  it('招待URLから開いた場合は招待の案内を出し、ログインに招待トークンを引き継ぐ', () => {
    render(<LoginPage returnTo="/invite?token=t1" loginError={null} inviteToken="t1" />);
    expect(screen.getByRole('note').textContent).toContain('招待が届いています');
    expect(screen.getByRole('link', { name: 'LINEでログイン' }).getAttribute('href')).toContain('&invite=t1');
  });
});
