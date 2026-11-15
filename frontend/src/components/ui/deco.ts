// 文字列（ID など）ごとに決まった装飾色のクラス名を返す。
import { decoIndex } from '../../lib/format.js';
import styles from './deco.module.css';

export function decoClassName(seed: string): string | undefined {
  return styles[`deco${decoIndex(seed)}`];
}
