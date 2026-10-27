import { describe, it, expect } from 'vitest';
import { SESSION_COOKIE_MAX_AGE_SECONDS } from '@photo-album/shared';
import {
  buildSessionCookie,
  buildClearSessionCookie,
  readSessionCookie,
  SESSION_COOKIE_NAME,
} from './cookie.js';

describe('buildSessionCookie', () => {
  it('Secure/HttpOnly/SameSite=Lax を含み、ブラウザ終了で消えない長期 Max-Age を持つ（実質無期限）', () => {
    const c = buildSessionCookie('tok');
    expect(c).toContain(`${SESSION_COOKIE_NAME}=tok`);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain(`Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`);
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBeGreaterThanOrEqual(365 * 24 * 60 * 60);
  });
});

describe('buildClearSessionCookie', () => {
  it('Max-Age=0 で即時失効', () => {
    expect(buildClearSessionCookie()).toContain('Max-Age=0');
  });
});

describe('readSessionCookie', () => {
  it('Cookieヘッダからトークンを取り出す', () => {
    expect(readSessionCookie(`a=1; ${SESSION_COOKIE_NAME}=tok; b=2`)).toBe('tok');
  });
  it('無ければ null', () => {
    expect(readSessionCookie('a=1; b=2')).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
  });
});
