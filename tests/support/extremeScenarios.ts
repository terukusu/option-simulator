/**
 * #144 AC-6: ΔX の数値欄の端（−99% / +900%）の検査に使う市場と基礎（架空の値）。
 * 通常の市場（basis ≥ 0）と、X₀ を 1 限月の F より 1,500 円上に置いた市場（basis_i < −0.01X₀ の足。円モードで
 * −99% のとき F_i' = X' + basis_i ≤ 0）。足は PERF_LEGS（OP 9 本 + ミニ先物）。
 */

import { preparePosition } from '../../model';
import type { MarketContext } from '../../model/position';
import { type PnlBase, pnlDomains } from '../../ui/view/pnlChart';
import { M1, M2, makeMarket } from './market';
import { PERF_LEGS } from './perfPosition';

export const NEG_BASIS = 1_500;

function baseOf(ctx: MarketContext, rows: ReturnType<typeof makeMarket>['rows']): PnlBase {
  const board = {
    months: [
      { F: M1.F, rows: rows[M1.id] ?? [] },
      { F: M2.F, rows: rows[M2.id] ?? [] },
    ],
  };
  const base = pnlDomains(board, preparePosition(PERF_LEGS, ctx), ctx);
  if (!base) throw new Error('損益グラフの基礎が作れない');
  return base;
}

/** [名前, 基礎] の組（通常 / basis が負） */
export function extremeBases(): Array<[string, PnlBase]> {
  const { ctx, rows } = makeMarket();
  const neg: MarketContext = { ...ctx, x0: M1.F + NEG_BASIS };
  return [
    ['basis ≥ 0', baseOf(ctx, rows)],
    ['basis < −0.01X₀', baseOf(neg, rows)],
  ];
}

/** 値の木の中の数値で有限でないもの（null・文字列は見ない）の位置 */
export function nonFinitePaths(v: unknown, path = ''): string[] {
  if (typeof v === 'number') return Number.isFinite(v) ? [] : [path];
  if (Array.isArray(v)) return v.flatMap((x, i) => nonFinitePaths(x, `${path}[${i}]`));
  if (v !== null && typeof v === 'object') {
    return Object.entries(v).flatMap(([k, x]) => nonFinitePaths(x, `${path}.${k}`));
  }
  return [];
}
