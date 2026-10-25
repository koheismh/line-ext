import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { generateState, generateNonce, generatePkce } from './pkce.js';

describe('generateState / generateNonce', () => {
  it('毎回異なるURLセーフ文字列', () => {
    expect(generateState()).not.toBe(generateState());
    expect(generateNonce()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('generatePkce', () => {
  it('challenge は sha256(verifier) の base64url、method は S256', () => {
    const p = generatePkce();
    expect(p.method).toBe('S256');
    const expected = createHash('sha256').update(p.verifier).digest('base64url');
    expect(p.challenge).toBe(expected);
  });
  it('verifier は PKCE の長さ要件(43〜128)内', () => {
    const p = generatePkce();
    expect(p.verifier.length).toBeGreaterThanOrEqual(43);
    expect(p.verifier.length).toBeLessThanOrEqual(128);
  });
});
