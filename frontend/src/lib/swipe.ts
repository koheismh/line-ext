// スワイプ（フリック）の方向判定（純粋関数）。
// 横に十分動き、かつ縦よりも横の動きが大きいときだけ前後への移動とみなす。
// 縦スクロールや小さなブレを、写真の切り替えと取り違えないためのしきい値。

/** 横方向に動かす最小距離（px） */
export const SWIPE_MIN_DISTANCE_PX = 50;

/**
 * 指の移動量から移動方向を返す。
 * - 左へフリック（dx < 0）＝次のメディア（'next'）
 * - 右へフリック（dx > 0）＝前のメディア（'prev'）
 * - それ以外（距離不足・斜め・縦の動き）は null
 */
export function swipeDirection(dx: number, dy: number): 'next' | 'prev' | null {
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE_PX) return null;
  if (Math.abs(dx) < Math.abs(dy) * 1.5) return null;
  return dx < 0 ? 'next' : 'prev';
}
