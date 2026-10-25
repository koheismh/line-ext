import { describe, it, expect } from 'vitest';
import { classifyConnection, decideUpload, type ConnectionVerdict } from './networkGuard.js';
import { LARGE_UPLOAD_THRESHOLD_BYTES } from '@photo-album/shared';

const T = LARGE_UPLOAD_THRESHOLD_BYTES;

function navWith(connection: unknown): Navigator {
  return { connection } as unknown as Navigator;
}

describe('classifyConnection', () => {
  it('connection無し（iOS Safari/PC）は unknown', () => {
    expect(classifyConnection(navWith(undefined)).kind).toBe('unknown');
  });
  it('wifi/ethernet は wifi_or_wired', () => {
    expect(classifyConnection(navWith({ type: 'wifi' })).kind).toBe('wifi_or_wired');
    expect(classifyConnection(navWith({ type: 'ethernet' })).kind).toBe('wifi_or_wired');
  });
  it('cellular は cellular', () => {
    expect(classifyConnection(navWith({ type: 'cellular' })).kind).toBe('cellular');
  });
  it('saveData ON は cellular 扱い', () => {
    expect(classifyConnection(navWith({ type: 'wifi', saveData: true })).kind).toBe('cellular');
  });
  it('未知のtypeは unknown', () => {
    expect(classifyConnection(navWith({ type: 'other' })).kind).toBe('unknown');
  });
});

describe('decideUpload', () => {
  const wifi: ConnectionVerdict = { kind: 'wifi_or_wired' };
  const cell: ConnectionVerdict = { kind: 'cellular' };
  const unknown: ConnectionVerdict = { kind: 'unknown' };

  it('小容量は常に proceed', () => {
    expect(decideUpload({ totalBytes: 100, fileCount: 1, verdict: cell, suppressed: false })).toEqual({
      action: 'proceed',
    });
  });
  it('大容量 + Wi-Fi は proceed', () => {
    expect(decideUpload({ totalBytes: T, fileCount: 1, verdict: wifi, suppressed: false })).toEqual({
      action: 'proceed',
    });
  });
  it('大容量 + モバイルは confirm(cellular)', () => {
    expect(decideUpload({ totalBytes: T, fileCount: 1, verdict: cell, suppressed: false })).toEqual({
      action: 'confirm',
      reason: 'cellular',
    });
  });
  it('大容量 + 判定不能は confirm(unknown)', () => {
    expect(decideUpload({ totalBytes: T, fileCount: 1, verdict: unknown, suppressed: false })).toEqual({
      action: 'confirm',
      reason: 'unknown',
    });
  });
  it('抑制中は大容量でも proceed', () => {
    expect(decideUpload({ totalBytes: T, fileCount: 1, verdict: unknown, suppressed: true })).toEqual({
      action: 'proceed',
    });
  });
  it('一括は合計で判定', () => {
    expect(
      decideUpload({ totalBytes: T, fileCount: 3, verdict: cell, suppressed: false }).action,
    ).toBe('confirm');
    expect(
      decideUpload({ totalBytes: T - 1, fileCount: 3, verdict: cell, suppressed: false }).action,
    ).toBe('proceed');
  });
});
