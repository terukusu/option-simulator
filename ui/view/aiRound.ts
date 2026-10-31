/**
 * AI のツールの結果の丸めと足の名札（#135・#139）。ui/view/aiTools.ts と ui/view/aiPropose.ts が共用する純関数。
 * 円は整数、% と pt は小数 1 桁、Δ は小数 2 桁、Γ は小数 3 桁。非有限は null、−0 は 0。
 */

import type { PreparedLeg } from '../../model';

import { fin } from './finite';

// fin は共用の ui/view/finite.ts（#20。AI のモジュールの外にも使うため）。import 先を変えないよう再び公開する
export { fin };
export const round = (v: number | null | undefined, d: number): number | null => {
  if (!fin(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f || 0;
};
export const yen = (v: number | null | undefined) => round(v, 0);
export const r1 = (v: number | null | undefined) => round(v, 1);
export const r2 = (v: number | null | undefined) => round(v, 2);
export const r3 = (v: number | null | undefined) => round(v, 3);

/** 足の名札（限月・種別・行使価格・売買・枚数。tools.py の LEG_ID） */
export function legId(p: Pick<PreparedLeg, 'leg'>): Record<string, unknown> {
  const l = p.leg;
  if (l.kind === 'future') {
    return { product: l.product, expiry: l.contract, side: l.side, qty: l.qty };
  }
  return {
    product: 'op',
    type: l.type === 'put' ? 'P' : 'C',
    expiry: l.expiry,
    k: l.strike,
    side: l.side,
    qty: l.qty,
  };
}

export const greeksOf = (g: {
  deltaLarge: number;
  deltaMini: number;
  gammaPer100: number;
  thetaPerDay: number;
  vegaPerPt: number;
}) => ({
  delta_large: r2(g.deltaLarge),
  delta_mini: r2(g.deltaMini),
  gamma_per100: r3(g.gammaPer100),
  theta_yen_per_day: yen(g.thetaPerDay),
  vega_yen_per_pt: yen(g.vegaPerPt),
});
