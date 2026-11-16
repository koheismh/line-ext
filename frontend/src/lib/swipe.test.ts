import { describe, it, expect } from 'vitest';
import { swipeDirection, SWIPE_MIN_DISTANCE_PX } from './swipe.js';

describe('swipeDirection', () => {
  it('左へ十分に動かすと次、右へ動かすと前', () => {
    expect(swipeDirection(-80, 0)).toBe('next');
    expect(swipeDirection(80, 0)).toBe('prev');
  });

  it('しきい値より短い動きは何もしない（ブレ・タップ）', () => {
    expect(swipeDirection(SWIPE_MIN_DISTANCE_PX - 1, 0)).toBeNull();
    expect(swipeDirection(-10, 2)).toBeNull();
    expect(swipeDirection(0, 0)).toBeNull();
  });

  it('縦の動きが大きい場合は縦スクロールとみなし、切り替えない', () => {
    expect(swipeDirection(60, 50)).toBeNull(); // 横より縦が大きい
    expect(swipeDirection(-60, 100)).toBeNull();
  });

  it('横の動きが縦より十分大きければ、縦のずれがあっても切り替える', () => {
    expect(swipeDirection(-60, 30)).toBe('next');
    expect(swipeDirection(-60, -35)).toBe('next');
  });
});
