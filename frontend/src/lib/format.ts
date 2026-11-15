// 表示用の整形（純粋関数）。

/** バイト数を MB 表記にする（1MB 未満も「1MB」と表示する）。 */
export function formatMb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024 / 1024))}MB`;
}

/** ISO 8601 の日時を「2026/01/02 3:04」形式にする。解釈できなければ空文字。 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
}

/** 装飾色の数（tokens.css の --color-deco-1〜6 と対応）。 */
export const DECO_COUNT = 6;

/** 文字列から装飾色の番号（1〜DECO_COUNT）を決める。同じ文字列にはいつも同じ番号を返す。 */
export function decoIndex(seed: string): number {
  let hash = 0;
  for (const ch of seed) {
    hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  }
  return (hash % DECO_COUNT) + 1;
}

/** 名前の最初の1文字（絵文字や濁点付きの文字も1文字として扱う）。空なら「?」。 */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '?';
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
    for (const { segment } of segmenter.segment(trimmed)) return segment;
  }
  return Array.from(trimmed)[0] ?? '?';
}
