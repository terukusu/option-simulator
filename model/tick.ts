import { FUTURE_TICK, type FutureProduct, OPTION_TICK_RULE } from './products';

export type RoundMode = 'nearest' | 'down' | 'up';

/** オプション価格 p での呼値（p ≤ 300 は 1 円、p > 300 は 5 円）。 */
export function optionTick(price: number): number {
  return price > OPTION_TICK_RULE.threshold ? OPTION_TICK_RULE.large : OPTION_TICK_RULE.small;
}

function roundTo(value: number, step: number, mode: RoundMode): number {
  const q = value / step;
  // 浮動小数の誤差（例: 302.5/5 = 60.49999…）で丸めの向きが変わらないよう少しだけ寄せる
  const eps = 1e-9;
  const n =
    mode === 'down' ? Math.floor(q + eps) : mode === 'up' ? Math.ceil(q - eps) : Math.round(q);
  return n * step;
}

/**
 * オプション価格を呼値の格子に丸める。格子は 0, 1, …, 300, 305, 310, … 円。
 * 'nearest' は格子の最も近い点（等距離は大きい方）、'down' / 'up' は切り下げ / 切り上げ。
 * 負の値は 0 にする。
 */
export function roundOptionPrice(price: number, mode: RoundMode = 'nearest'): number {
  if (!Number.isFinite(price)) return price;
  if (price <= 0) return 0;
  const { threshold, small, large } = OPTION_TICK_RULE;
  if (price <= threshold) return roundTo(price, small, mode);
  // 300 円超は 5 円刻み。300 自体も格子の点なので 5 円刻みの格子（0, 5, …）に乗る
  return Math.max(threshold, roundTo(price, large, mode));
}

/** 呼値 n 本分だけ価格をずらす（板の生成・既定の建値「ask − 呼値」に使う）。300 円の境界をまたぐ。 */
export function shiftOptionTicks(price: number, ticks: number): number {
  let p = roundOptionPrice(price);
  const dir = Math.sign(ticks);
  for (let i = 0; i < Math.abs(ticks); i++) {
    if (dir > 0) {
      // 300 の次は 305（300 円超は 5 円刻み）
      p += p >= OPTION_TICK_RULE.threshold ? OPTION_TICK_RULE.large : OPTION_TICK_RULE.small;
    } else {
      const down = p > OPTION_TICK_RULE.threshold ? OPTION_TICK_RULE.large : OPTION_TICK_RULE.small;
      p = Math.max(0, p - down);
    }
  }
  return p;
}

/** 先物の価格を呼値で丸める（建値の入力用）。 */
export function roundFuturePrice(
  price: number,
  product: FutureProduct,
  mode: RoundMode = 'nearest',
): number {
  if (!Number.isFinite(price)) return price;
  return roundTo(price, FUTURE_TICK[product], mode);
}
