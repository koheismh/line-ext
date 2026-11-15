/** クラス名を結合する（false・null・undefined・空文字は無視する）。 */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
