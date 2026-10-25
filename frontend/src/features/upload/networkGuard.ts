// 回線ガードのロジック（純粋関数中心）。requirements 要件4-16〜4-20 準拠。
//  - Wi-Fi/有線と「確実に」判定できたときのみ自動開始を許可
//  - それ以外（モバイル回線・判定不能・取得不可）はブロック
//  - ブロック理由を「モバイル回線」と「判定不可」で区別
//  - ユーザー承認後は同一端末で24時間、同種の確認を抑制

import { UPLOAD_GUARD_SUPPRESS_MS, isLargeUploadThreshold } from './size.js';

/** Network Information API の最小型（ブラウザ差異を吸収）。 */
interface NetworkInformationLike {
  type?: string;
  effectiveType?: string;
  saveData?: boolean;
}

export type ConnectionVerdict =
  | { kind: 'wifi_or_wired' } // 確実にWi-Fi/有線
  | { kind: 'cellular' } // モバイル回線と判定
  | { kind: 'unknown' }; // 判定不能・取得不可

/** navigator.connection から接続種別を判定する。 */
export function classifyConnection(nav: Navigator = navigator): ConnectionVerdict {
  const conn = (nav as Navigator & { connection?: NetworkInformationLike }).connection;
  if (!conn || typeof conn.type !== 'string') {
    // 取得不可（iOS Safari、PCのChrome/Edge等）
    return { kind: 'unknown' };
  }
  if (conn.saveData === true) {
    // データセーバーONはモバイル相当として扱う
    return { kind: 'cellular' };
  }
  if (conn.type === 'wifi' || conn.type === 'ethernet') {
    return { kind: 'wifi_or_wired' };
  }
  if (conn.type === 'cellular') {
    return { kind: 'cellular' };
  }
  // bluetooth/wimax/other/none/unknown 等は安全側で unknown
  return { kind: 'unknown' };
}

const SUPPRESS_KEY = 'uploadGuardSuppressUntil';

/** 承認抑制が有効か（localStorage に保存した期限で判定）。 */
export function isGuardSuppressed(now: number = Date.now(), storage: Storage = localStorage): boolean {
  const raw = storage.getItem(SUPPRESS_KEY);
  if (!raw) return false;
  const until = Number(raw);
  return Number.isFinite(until) && until > now;
}

/** ユーザー承認時に24時間の抑制を記録する。 */
export function suppressGuard(now: number = Date.now(), storage: Storage = localStorage): void {
  storage.setItem(SUPPRESS_KEY, String(now + UPLOAD_GUARD_SUPPRESS_MS));
}

export type GuardDecision =
  | { action: 'proceed' } // そのままアップロード
  | { action: 'confirm'; reason: 'cellular' | 'unknown' }; // 確認を表示

/**
 * アップロード前の判定。
 * - 小容量: 常に proceed
 * - 大容量: 抑制中 or Wi-Fi/有線 → proceed、それ以外 → confirm（理由付き）
 */
export function decideUpload(params: {
  totalBytes: number;
  fileCount: number;
  verdict: ConnectionVerdict;
  suppressed: boolean;
}): GuardDecision {
  const isLarge = isLargeUploadThreshold(params.totalBytes, params.fileCount);
  if (!isLarge) return { action: 'proceed' };
  if (params.suppressed) return { action: 'proceed' };
  if (params.verdict.kind === 'wifi_or_wired') return { action: 'proceed' };
  return { action: 'confirm', reason: params.verdict.kind };
}
