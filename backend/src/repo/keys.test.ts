import { describe, it, expect } from 'vitest';
import { metaKeys, mediaKeys, sha256Hex } from './keys.js';

describe('sha256Hex', () => {
  it('同じ入力は同じハッシュ、平文を含まない', () => {
    const h = sha256Hex('secret-token');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('secret');
    expect(sha256Hex('secret-token')).toBe(h);
  });
});

describe('metaKeys', () => {
  it('アルバム・メディア・locatorのキー構造', () => {
    expect(metaKeys.album('group', 'g1', 'a1')).toBe('albums/group/g1/a1.json');
    expect(metaKeys.media('a1', 'm1')).toBe('media/a1/m1.json');
    expect(metaKeys.mediaLocator('m1')).toBe('media-locator/m1.json');
    expect(metaKeys.albumLocator('a1')).toBe('album-locator/a1.json');
    expect(metaKeys.commentLocator('c1')).toBe('comment-locator/c1.json');
  });
  it('招待キーはトークンのハッシュ（平文を含まない）', () => {
    const key = metaKeys.invite('plain-token');
    expect(key).toMatch(/^invites\/[0-9a-f]{64}\.json$/);
    expect(key).not.toContain('plain-token');
  });
});

describe('mediaKeys', () => {
  it('originals/previews/trash のキー構造', () => {
    expect(mediaKeys.original('a1', 'm1', 'jpg')).toBe('originals/a1/m1/source.jpg');
    expect(mediaKeys.preview('a1', 'm1')).toBe('previews/a1/m1/thumbnail.jpg');
    expect(mediaKeys.trashOriginal('2026-01-01', 'a1', 'm1', 'mp4')).toBe(
      'trash/2026-01-01/a1/m1/source.mp4',
    );
    expect(mediaKeys.trashPreview('2026-01-01', 'a1', 'm1')).toBe(
      'trash/2026-01-01/a1/m1/thumbnail.jpg',
    );
  });
});
