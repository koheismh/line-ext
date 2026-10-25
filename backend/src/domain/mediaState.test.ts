import { describe, it, expect } from 'vitest';
import {
  canTransition,
  shouldSkipProcessing,
  isPubliclyVisible,
  canIssueMediaUrl,
  canStartDelete,
} from './mediaState.js';

describe('canTransition', () => {
  it('正常系の前進遷移を許可する', () => {
    expect(canTransition('uploading', 'validating')).toBe(true);
    expect(canTransition('validating', 'ready')).toBe(true);
    expect(canTransition('validating', 'error')).toBe(true);
    expect(canTransition('ready', 'deleting')).toBe(true);
    expect(canTransition('deleting', 'trashed')).toBe(true);
  });

  it('後戻り・未定義の遷移を拒否する（単調性）', () => {
    expect(canTransition('ready', 'validating')).toBe(false);
    expect(canTransition('trashed', 'ready')).toBe(false);
    expect(canTransition('ready', 'uploading')).toBe(false);
    expect(canTransition('expired', 'ready')).toBe(false);
  });

  it('error→validation(再処理)は preview_failed のみ許可', () => {
    expect(canTransition('error', 'validating', 'preview_failed')).toBe(true);
    expect(canTransition('error', 'validating', 'invalid_file')).toBe(false);
    expect(canTransition('error', 'validating', null)).toBe(false);
  });

  it('error→deleting は理由によらず許可', () => {
    expect(canTransition('error', 'deleting', 'invalid_file')).toBe(true);
    expect(canTransition('error', 'deleting', 'preview_failed')).toBe(true);
  });

  it('放置失効への遷移を許可', () => {
    expect(canTransition('uploading', 'expired')).toBe(true);
    expect(canTransition('validating', 'expired')).toBe(true);
  });
});

describe('shouldSkipProcessing', () => {
  it('deleting/trashed/expired は skip', () => {
    expect(shouldSkipProcessing('deleting')).toBe(true);
    expect(shouldSkipProcessing('trashed')).toBe(true);
    expect(shouldSkipProcessing('expired')).toBe(true);
  });
  it('error(invalid_file) は skip、error(preview_failed) は処理対象', () => {
    expect(shouldSkipProcessing('error', 'invalid_file')).toBe(true);
    expect(shouldSkipProcessing('error', 'preview_failed')).toBe(false);
  });
  it('validating は処理対象', () => {
    expect(shouldSkipProcessing('validating')).toBe(false);
  });
});

describe('可視性・URL発行・削除可否', () => {
  it('一般表示は ready のみ', () => {
    expect(isPubliclyVisible('ready')).toBe(true);
    expect(isPubliclyVisible('uploading')).toBe(false);
    expect(isPubliclyVisible('deleting')).toBe(false);
    expect(isPubliclyVisible('error')).toBe(false);
  });
  it('URL発行は ready のみ', () => {
    expect(canIssueMediaUrl('ready')).toBe(true);
    expect(canIssueMediaUrl('deleting')).toBe(false);
  });
  it('削除開始は ready と error', () => {
    expect(canStartDelete('ready')).toBe(true);
    expect(canStartDelete('error')).toBe(true);
    expect(canStartDelete('uploading')).toBe(false);
    expect(canStartDelete('trashed')).toBe(false);
  });
});
