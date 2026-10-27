import { describe, it, expect } from 'vitest';
import {
  validateUploadDeclaration,
  validateText,
  isLargeUpload,
  mediaKindFromMime,
} from './validation.js';
import { MAX_PHOTO_BYTES, MAX_VIDEO_BYTES, LARGE_UPLOAD_THRESHOLD_BYTES } from '@photo-album/shared';

describe('mediaKindFromMime', () => {
  it('写真MIMEをphotoに判定', () => {
    expect(mediaKindFromMime('image/jpeg')).toBe('photo');
    expect(mediaKindFromMime('image/png')).toBe('photo');
    expect(mediaKindFromMime('image/webp')).toBe('photo');
  });
  it('動画MIMEをvideoに判定（MOV含む）', () => {
    expect(mediaKindFromMime('video/mp4')).toBe('video');
    expect(mediaKindFromMime('video/quicktime')).toBe('video');
  });
  it('対応外はnull', () => {
    expect(mediaKindFromMime('image/heic')).toBeNull();
    expect(mediaKindFromMime('application/pdf')).toBeNull();
  });
});

describe('validateUploadDeclaration', () => {
  it('対応形式・容量内なら ok', () => {
    const r = validateUploadDeclaration({ declaredMimeType: 'image/jpeg', declaredByteSize: 1000 });
    expect(r).toEqual({ ok: true, kind: 'photo' });
  });
  it('対応外形式を拒否', () => {
    const r = validateUploadDeclaration({ declaredMimeType: 'image/heic', declaredByteSize: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('unsupported_type');
  });
  it('写真の容量超過を拒否', () => {
    const r = validateUploadDeclaration({
      declaredMimeType: 'image/png',
      declaredByteSize: MAX_PHOTO_BYTES + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('too_large');
  });
  it('動画は写真上限を超えても500MBまで許可', () => {
    const r = validateUploadDeclaration({
      declaredMimeType: 'video/mp4',
      declaredByteSize: MAX_PHOTO_BYTES + 1,
    });
    expect(r.ok).toBe(true);
  });
  it('動画の容量超過を拒否', () => {
    const r = validateUploadDeclaration({
      declaredMimeType: 'video/mp4',
      declaredByteSize: MAX_VIDEO_BYTES + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('too_large');
  });
  it('サイズ0や負数を拒否', () => {
    expect(validateUploadDeclaration({ declaredMimeType: 'image/jpeg', declaredByteSize: 0 }).ok).toBe(false);
    expect(validateUploadDeclaration({ declaredMimeType: 'image/jpeg', declaredByteSize: -1 }).ok).toBe(false);
  });
});

describe('validateText', () => {
  const rule = { label: '本文', max: 5 };
  it('文字列・長さ内・制御文字なしなら ok（値は加工しない）', () => {
    expect(validateText(' ab ', rule)).toEqual({ ok: true, value: ' ab ' });
  });
  it('空白のみ・長すぎ・文字列以外は拒否', () => {
    expect(validateText('  ', rule).ok).toBe(false);
    expect(validateText('123456', rule).ok).toBe(false);
    expect(validateText(1, rule).ok).toBe(false);
    expect(validateText(undefined, rule).ok).toBe(false);
  });
  it('allowEmpty なら空文字を許可', () => {
    expect(validateText('', { ...rule, allowEmpty: true }).ok).toBe(true);
  });
  it('改行は multiline のときだけ許可、その他の制御文字は常に拒否', () => {
    expect(validateText('a\nb', rule).ok).toBe(false);
    expect(validateText('a\nb', { ...rule, multiline: true }).ok).toBe(true);
    expect(validateText('a\u0007b', { ...rule, multiline: true }).ok).toBe(false);
    expect(validateText('a\u007fb', { ...rule, multiline: true }).ok).toBe(false);
  });
});

describe('isLargeUpload', () => {
  const T = LARGE_UPLOAD_THRESHOLD_BYTES;
  it('単体: 閾値以上で true', () => {
    expect(isLargeUpload([T])).toBe(true);
    expect(isLargeUpload([T - 1])).toBe(false);
  });
  it('一括: 合計で判定', () => {
    expect(isLargeUpload([T / 2, T / 2])).toBe(true);
    expect(isLargeUpload([T / 4, T / 4])).toBe(false);
  });
  it('空は false', () => {
    expect(isLargeUpload([])).toBe(false);
  });
});
