/**
 * デルタヘッジの枚数（純関数）。設計 docs/design.md 5.8・M11・M12、AC19。
 *
 * - 単位: 現在・目標・残り・1 枚の Δ はラージ先物換算の枚数（5.6）。枚数は商品の枚数（符号 = 売買、+ は買い）
 * - 枚数 = round((目標 − 現在) / 1 枚の Δ)。商の浮動小数の端数を 1e-9 の格子に丸めてから、ちょうど半分は
 *   +∞ 側に寄せる（Math.round）。足した後に求め直すと商は [−0.5, 0.5) に入るので 0 枚になる
 *   （half away from zero だと −0.5 が −1 になり、再ヘッジで ±1 枚の往復になる）
 * - 残り = 現在 + 枚数 × 1 枚の Δ − 目標（追加後の Δ − 目標）。|残り| ≤ 1 枚の Δ / 2
 */

import { LARGE_MULTIPLIER, PRODUCTS } from './products';

export interface HedgeLots {
  /** 必要枚数（整数。+ 買い、− 売り。−0 は返さない） */
  lots: number;
  /** 枚数を足した後の Δ − 目標（ラージ換算） */
  residual: number;
  /** 1 枚の Δ（ラージ換算） */
  perLot: number;
}

export interface HedgePerLot {
  mini: number;
  large: number;
  micro: number;
}

/** 1 枚の Δ（ラージ換算）= 乗数 / 1,000（先物の δ = 1）: ミニ 0.1・ラージ 1・マイクロ 0.01 */
export const HEDGE_PER_LOT: Readonly<HedgePerLot> = {
  mini: PRODUCTS.fut_mini.multiplier / LARGE_MULTIPLIER,
  large: PRODUCTS.fut_large.multiplier / LARGE_MULTIPLIER,
  micro: PRODUCTS.fut_micro.multiplier / LARGE_MULTIPLIER,
};

/** 商を丸める格子（ちょうど半分の判定の許容） */
const GRID = 1e9;

/** 現在 Δ を目標にする枚数と残り。非有限・1 枚の Δ ≤ 0 なら null。 */
export function hedgeLots(current: number, target: number, perLot: number): HedgeLots | null {
  if (!Number.isFinite(current) || !Number.isFinite(target)) return null;
  if (!(Number.isFinite(perLot) && perLot > 0)) return null;
  const raw = (target - current) / perLot;
  if (!Number.isFinite(raw)) return null;
  // |商| が 1e6 以上は格子に丸めると 2^53 を超えるので丸めない（端数の分解能はもともと 1e-9 より粗い）
  const q = Math.abs(raw) < 1e6 ? Math.round(raw * GRID) / GRID : raw;
  // || 0: −0 を 0 に
  const lots = Math.round(q) || 0;
  return { lots, residual: current + lots * perLot - target, perLot };
}

export interface DeltaHedge {
  /** 目標 − 現在（ラージ換算） */
  diff: number;
  mini: HedgeLots;
  large: HedgeLots;
  /** ミニが 0 枚に丸まるときだけマイクロ換算を併記（M11）。それ以外は null */
  micro: HedgeLots | null;
}

/** ミニ・ラージ（とミニ 0 枚のときマイクロ）の枚数。非有限・1 枚の Δ ≤ 0 なら null。 */
export function deltaHedge(
  current: number,
  target: number,
  perLot: HedgePerLot = HEDGE_PER_LOT,
): DeltaHedge | null {
  const mini = hedgeLots(current, target, perLot.mini);
  const large = hedgeLots(current, target, perLot.large);
  if (!mini || !large) return null;
  const micro = mini.lots === 0 ? hedgeLots(current, target, perLot.micro) : null;
  return { diff: target - current, mini, large, micro };
}
