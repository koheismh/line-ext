import { describe, it, expect } from 'vitest';
import {
  buildSessionCookie,
  buildClearSessionCookie,
  readSessionCookie,
  SESSION_COOKIE_NAME,
} from './cookie.js';

describe('buildSessionCookie', () => {
  it('Secure/HttpOnly/SameSite=Lax を含み Max-Age は無い（無期限）', () => {
    const c = buildSessionCookie('tok');
    expect(c).toContain(`${SESSION_COOKIE_NAME}=tok`);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(c).not.toContain('Max-Age');
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
