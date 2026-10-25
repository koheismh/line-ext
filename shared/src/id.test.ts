import { describe, it, expect } from 'vitest';
import { ulid, randomId } from './id.js';

describe('ulid', () => {
  it('26文字で生成される', () => {
    expect(ulid()).toHaveLength(26);
  });

  it('Crockford Base32 の文字のみを含む', () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('生成時刻が後のULIDは辞書順でも後になる（時刻順）', () => {
    const earlier = ulid(1_000_000_000_000);
    const later = ulid(2_000_000_000_000);
    expect(earlier < later).toBe(true);
  });

  it('同一時刻でも毎回異なる値になる（ランダム部）', () => {
    const t = 1_700_000_000_000;
    const a = ulid(t);
    const b = ulid(t);
    expect(a).not.toBe(b);
    // 時刻部（先頭10文字）は一致する
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
  });
});

describe('randomId', () => {
  it('UUID形式で生成される', () => {
    expect(randomId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
