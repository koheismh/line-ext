// アップロード申告値のバリデーション（純粋関数）。
// サーバ側の必須検証。実ファイル検証（マジックバイト等）は別途S3イベントで行う。

import {
  SUPPORTED_MIME_TYPES,
  MAX_PHOTO_BYTES,
  MAX_VIDEO_BYTES,
  LARGE_UPLOAD_THRESHOLD_BYTES,
  type MediaKind,
} from '@photo-album/shared';

/** MIMEからメディア種別を判定する。対応外は null。 */
export function mediaKindFromMime(mime: string): MediaKind | null {
  if (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/webp') {
    return 'photo';
  }
  if (mime === 'video/mp4' || mime === 'video/quicktime') {
    return 'video';
  }
  return null;
}

/** 対応形式か（拡張子でなくMIMEで判定）。 */
export function isSupportedMime(mime: string): boolean {
  return (SUPPORTED_MIME_TYPES as readonly string[]).includes(mime);
}

export interface UploadValidationInput {
  declaredMimeType: string;
  declaredByteSize: number;
}

export type UploadValidationResult =
  | { ok: true; kind: MediaKind }
  | { ok: false; code: 'unsupported_type' | 'too_large' | 'invalid_size'; message: string };

/**
 * アップロード申告値を検証する。
 * - 対応形式か
 * - 種別ごとの容量上限内か
 */
export function validateUploadDeclaration(
  input: UploadValidationInput,
): UploadValidationResult {
  const kind = mediaKindFromMime(input.declaredMimeType);
  if (kind === null || !isSupportedMime(input.declaredMimeType)) {
    return {
      ok: false,
      code: 'unsupported_type',
      message:
        '対応していないファイル形式です。写真はJPEG/PNG/WebP、動画はMP4またはMOV(H.264)をご利用ください。',
    };
  }
  if (!Number.isInteger(input.declaredByteSize) || input.declaredByteSize <= 0) {
    return { ok: false, code: 'invalid_size', message: 'ファイルサイズが不正です。' };
  }
  const limit = kind === 'photo' ? MAX_PHOTO_BYTES : MAX_VIDEO_BYTES;
  if (input.declaredByteSize > limit) {
    const limitMb = Math.floor(limit / (1024 * 1024));
    return {
      ok: false,
      code: 'too_large',
      message: `ファイルが大きすぎます（上限 ${limitMb}MB）。`,
    };
  }
  return { ok: true, kind };
}

/**
 * 大容量ガードの判定単位。
 * - 一括選択（複数）: 合計サイズで判定
 * - 単体: そのサイズで判定
 * @returns 閾値以上なら true（＝回線ガード対象）
 */
export function isLargeUpload(byteSizes: number[]): boolean {
  if (byteSizes.length === 0) return false;
  const total =
    byteSizes.length === 1 ? byteSizes[0]! : byteSizes.reduce((a, b) => a + b, 0);
  return total >= LARGE_UPLOAD_THRESHOLD_BYTES;
}

// ---- 利用者入力文字列の検証（要件6-10: 長さ上限・制御文字・空文字のみ検証。HTMLエスケープはしない） ----

/** 改行・タブ以外の制御文字（複数行入力で許可しないもの）。 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** 1行入力で許可しない制御文字（改行・タブも不可）。 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_SINGLE_LINE = /[\u0000-\u001f\u007f]/;

export interface TextRule {
  /** 利用者向けメッセージに使う項目名。 */
  label: string;
  /** 最大文字数。 */
  max: number;
  /** 空（空白のみを含む）を許可するか。 */
  allowEmpty?: boolean;
  /** 改行を許可するか（コメント本文・説明など）。 */
  multiline?: boolean;
}

export type TextValidationResult = { ok: true; value: string } | { ok: false; message: string };

/**
 * 利用者入力文字列を検証する（純粋関数）。
 * 値は加工せずに返す（トリムするかは呼び出し側で決める）。
 */
export function validateText(value: unknown, rule: TextRule): TextValidationResult {
  if (typeof value !== 'string') {
    return { ok: false, message: `${rule.label}が不正です。` };
  }
  if (!rule.allowEmpty && value.trim().length === 0) {
    return { ok: false, message: `${rule.label}を入力してください。` };
  }
  if (value.length > rule.max) {
    return { ok: false, message: `${rule.label}は${rule.max}文字以内で入力してください。` };
  }
  const forbidden = rule.multiline ? CONTROL_CHARS_MULTILINE : CONTROL_CHARS_SINGLE_LINE;
  if (forbidden.test(value)) {
    return { ok: false, message: `${rule.label}に使用できない文字が含まれています。` };
  }
  return { ok: true, value };
}
