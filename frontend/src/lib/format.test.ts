import { describe, it, expect } from 'vitest';
import { DECO_COUNT, decoIndex, formatDateTime, formatMb, initialOf } from './format.js';

describe('formatMb', () => {
  it('MB に丸め、1MB 未満は 1MB と表示する', () => {
    expect(formatMb(10)).toBe('1MB');
    expect(formatMb(50 * 1024 * 1024)).toBe('50MB');
    expect(formatMb(1.6 * 1024 * 1024)).toBe('2MB');
  });
});

describe('formatDateTime', () => {
  it('解釈できない日時は空文字', () => {
    expect(formatDateTime('not-a-date')).toBe('');
  });
  it('日時を短い形式で返す', () => {
    expect(formatDateTime('2026-01-02T03:04:00Z')).toMatch(/2026/);
  });
});

describe('decoIndex', () => {
  it('1〜DECO_COUNT の範囲で、同じ文字列には同じ番号を返す', () => {
    for (const seed of ['', 'a', 'user-123', 'アルバム', '😀']) {
      const n = decoIndex(seed);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(DECO_COUNT);
      expect(decoIndex(seed)).toBe(n);
    }
  });
  it('文字列が違えば色がばらける', () => {
    const used = new Set(Array.from({ length: 30 }, (_, i) => decoIndex(`id-${i}`)));
    expect(used.size).toBeGreaterThan(3);
  });
});

describe('initialOf', () => {
  it('最初の1文字を返す（前後の空白は無視）', () => {
    expect(initialOf('  さくら')).toBe('さ');
    expect(initialOf('Bob')).toBe('B');
  });
  it('絵文字・結合文字も1文字として扱う', () => {
    expect(initialOf('👨‍👩‍👧 家族')).toBe('👨‍👩‍👧');
    expect(initialOf('が')).toBe('が');
  });
  it('空なら ?', () => {
    expect(initialOf('   ')).toBe('?');
  });
});
