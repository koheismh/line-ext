import { describe, it, expect } from 'vitest';
import { safeReturnPath } from './redirect.js';

describe('safeReturnPath', () => {
  it('同一オリジンの相対パスは許可', () => {
    expect(safeReturnPath('/albums/a1')).toBe('/albums/a1');
    expect(safeReturnPath('/invite?token=x')).toBe('/invite?token=x');
  });
  it('未指定はfallback', () => {
    expect(safeReturnPath(null)).toBe('/');
    expect(safeReturnPath(undefined)).toBe('/');
    expect(safeReturnPath('')).toBe('/');
  });
  it('絶対URL・別オリジン誘導は拒否', () => {
    expect(safeReturnPath('https://evil.com')).toBe('/');
    expect(safeReturnPath('http://evil.com/x')).toBe('/');
    expect(safeReturnPath('//evil.com')).toBe('/');
    expect(safeReturnPath('/\\evil.com')).toBe('/');
    expect(safeReturnPath('\\evil.com')).toBe('/');
  });
  it('相対でないパスは拒否', () => {
    expect(safeReturnPath('albums/a1')).toBe('/');
  });
  it('制御文字・空白混入は拒否', () => {
    expect(safeReturnPath('/a\nb')).toBe('/');
    expect(safeReturnPath('/a b')).toBe('/');
  });
});
