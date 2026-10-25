import { describe, it, expect } from 'vitest';
import { isMutating, isAllowedByCsrf, originFromReferer } from './csrf.js';

const ORIGIN = 'https://app.example.com';

describe('isMutating', () => {
  it('変更系メソッドを判定', () => {
    expect(isMutating('POST')).toBe(true);
    expect(isMutating('delete')).toBe(true);
    expect(isMutating('GET')).toBe(false);
    expect(isMutating('HEAD')).toBe(false);
  });
});

describe('isAllowedByCsrf', () => {
  it('GETは常に許可', () => {
    expect(isAllowedByCsrf('GET', null, ORIGIN)).toBe(true);
  });
  it('変更系は同一オリジンのみ許可', () => {
    expect(isAllowedByCsrf('POST', ORIGIN, ORIGIN)).toBe(true);
    expect(isAllowedByCsrf('POST', 'https://evil.com', ORIGIN)).toBe(false);
  });
  it('変更系でOrigin不在は拒否', () => {
    expect(isAllowedByCsrf('DELETE', null, ORIGIN)).toBe(false);
    expect(isAllowedByCsrf('DELETE', undefined, ORIGIN)).toBe(false);
  });
});

describe('originFromReferer', () => {
  it('Refererからオリジンを抽出', () => {
    expect(originFromReferer('https://app.example.com/albums/1')).toBe('https://app.example.com');
  });
  it('不正は null', () => {
    expect(originFromReferer('not-a-url')).toBeNull();
    expect(originFromReferer(undefined)).toBeNull();
  });
});
