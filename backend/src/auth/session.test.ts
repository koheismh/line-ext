import { describe, it, expect } from 'vitest';
import { signSession, verifySession, isSessionActive } from './session.js';

const SECRET = 'test-secret-key';

describe('signSession / verifySession', () => {
  it('署名→検証で payload を復元', () => {
    const token = signSession({ userId: 'u1', sessionVersion: 3 }, SECRET);
    expect(verifySession(token, SECRET)).toEqual({ userId: 'u1', sessionVersion: 3 });
  });

  it('別の鍵では検証失敗', () => {
    const token = signSession({ userId: 'u1', sessionVersion: 1 }, SECRET);
    expect(verifySession(token, 'other-secret')).toBeNull();
  });

  it('改ざんされた本文は検証失敗', () => {
    const token = signSession({ userId: 'u1', sessionVersion: 1 }, SECRET);
    const tampered = 'x' + token;
    expect(verifySession(tampered, SECRET)).toBeNull();
  });

  it('形式不正は null', () => {
    expect(verifySession('nodot', SECRET)).toBeNull();
    expect(verifySession('', SECRET)).toBeNull();
  });
});

describe('isSessionActive', () => {
  it('版数一致で有効、不一致（ログアウト後）は無効', () => {
    expect(isSessionActive({ userId: 'u1', sessionVersion: 2 }, 2)).toBe(true);
    expect(isSessionActive({ userId: 'u1', sessionVersion: 2 }, 3)).toBe(false);
  });
});
