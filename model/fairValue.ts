/**
 * 気配の広い行の妥当な価格（理論価格。#264、docs/design.md 5.3「理論価格」）。純関数。
 *
 * 今のスマイルは各行の mid（無ければ片側）を節点にして結ぶので、スマイルの IV からの価格はその行の mid / 片側の価格
 * そのものになる。ここでは **その行の気配を使わず**、周りの気配の狭い行（OTM 側・mid が節点・不安定でない・
 * bid と ask の IV の差 ≤ 5pt）だけで同じ補間器（PiecewiseLinearSmile。総分散の区分線形・既定の翼の規則）を作り直し、
 * その IV で Black-76 の価格を求める。式は既存のもの（PiecewiseLinearSmile・black76Price）だけ。
 */

import { black76Price, type OptionType } from './black76';
import { PiecewiseLinearSmile, type SmileFit, type SmileNode } from './smile';

/** 「気配の狭い行」の bid と ask の IV の差の上限（σ 単位。0.05 = 5pt。不安定の帯の既定と同じ値） */
export const FAIR_MAX_SPREAD_IV = 0.05;

export interface FairValue {
  /** 理論価格（円。呼値に丸めない） */
  price: number;
  /** 使った IV（小数） */
  iv: number;
  /** 周りの狭い行の内側（補間）か外側（外挿）か。その行自身は使わないので節点にはならない */
  mark: 'interpolated' | 'extrapolated';
}

/** 理論価格に使える節点（両側気配の mid・不安定でない・bid と ask の IV の差が上限以下）。 */
export function isTightNode(n: SmileNode, maxSpreadIv = FAIR_MAX_SPREAD_IV): boolean {
  return (
    n.source === 'mid' &&
    !n.unstable &&
    n.bidIv !== null &&
    n.askIv !== null &&
    n.askIv - n.bidIv <= maxSpreadIv
  );
}

/** 理論価格の IV と印（種別に依らない。price は種別ごとに black76Price で求める） */
export interface FairIv {
  iv: number;
  mark: 'interpolated' | 'extrapolated';
}

/**
 * 行使価格の列 ks の理論価格の IV（板の全行を 1 回で。#264）。各 k について、k 自身の節点を除いた気配の狭い節点の
 * PiecewiseLinearSmile の σ(ln(k/F))。狭い節点が 2 本未満・F / T / k が不正なら null。
 * 作り直しを減らすだけで値は 1 本ずつ作るのと同じ: k が狭い節点でなければ全部の狭い節点の 1 本。k が狭い節点で
 * 両隣があれば、x_k は両隣の間なので両隣 2 本の補間と同じ（翼の傾きは効かない）。端の節点のときだけ 1 本を除いて作り直す。
 */
export function smileFairIvs(
  fit: SmileFit | null,
  F: number,
  T: number,
  ks: readonly number[],
  maxSpreadIv = FAIR_MAX_SPREAD_IV,
): (FairIv | null)[] {
  if (!fit || !(F > 0) || !Number.isFinite(F) || !(T > 0)) return ks.map(() => null);
  const tight = fit.nodes.filter((n) => isTightNode(n, maxSpreadIv)).sort((a, b) => a.x - b.x);
  const pt = (n: SmileNode) => ({ x: n.x, w: n.iv * n.iv * T });
  const all = tight.length >= 2 ? new PiecewiseLinearSmile(tight.map(pt), T, 'slope', 2, F) : null;
  const index = new Map(tight.map((n, i) => [n.k, i]));
  return ks.map((k) => {
    if (!(k > 0)) return null;
    const i = index.get(k);
    let smile: PiecewiseLinearSmile | null = all;
    if (i !== undefined) {
      const rest = tight.length - 1;
      if (rest < 2) smile = null;
      else if (i > 0 && i < tight.length - 1) {
        smile = new PiecewiseLinearSmile(
          [pt(tight[i - 1] as SmileNode), pt(tight[i + 1] as SmileNode)],
          T,
          'slope',
          2,
          F,
        );
      } else {
        smile = new PiecewiseLinearSmile(tight.filter((_, j) => j !== i).map(pt), T, 'slope', 2, F);
      }
    }
    if (!smile) return null;
    const x = Math.log(k / F);
    const iv = smile.sigma(x);
    if (!(iv > 0) || !Number.isFinite(iv)) return null;
    return { iv, mark: smile.mark(x) === 'extrapolated' ? 'extrapolated' : 'interpolated' };
  });
}

/** 理論価格の IV から種別 type の価格（有限・正でなければ null）。 */
export function fairValueOf(
  f: FairIv | null,
  F: number,
  T: number,
  r: number,
  k: number,
  type: OptionType,
): FairValue | null {
  if (!f) return null;
  const price = black76Price(type, F, k, T, f.iv, r);
  if (!Number.isFinite(price) || !(price > 0)) return null;
  return { price, iv: f.iv, mark: f.mark };
}

/**
 * 行使価格 k・種別 type の理論価格。k 自身の節点を除いた気配の狭い節点が 2 本未満、F・T が不正なら null。
 * put / call は同じ IV（PCP を満たす）。
 */
export function smileFairValue(
  fit: SmileFit | null,
  F: number,
  T: number,
  r: number,
  k: number,
  type: OptionType,
  maxSpreadIv = FAIR_MAX_SPREAD_IV,
): FairValue | null {
  const [f] = smileFairIvs(fit, F, T, [k], maxSpreadIv);
  return fairValueOf(f ?? null, F, T, r, k, type);
}

export type FairPosition =
  | 'below_bid'
  | 'near_bid'
  | 'middle'
  | 'near_ask'
  | 'above_ask'
  | 'above_bid'
  | 'below_ask';

/**
 * 理論価格がその行の気配のどこか。両側気配なら bid 未満 / bid 寄り（幅の 1/3 まで）/ 中ほど / ask 寄り（2/3 から）/
 * ask 超。片側だけなら その側より上か下か。気配が無ければ null。
 */
export function fairPosition(
  price: number,
  bid: number | null,
  ask: number | null,
): FairPosition | null {
  const b = bid !== null && bid > 0 ? bid : null;
  const a = ask !== null && ask > 0 ? ask : null;
  if (b !== null && a !== null && b < a) {
    if (price < b) return 'below_bid';
    if (price > a) return 'above_ask';
    const t = (price - b) / (a - b);
    return t <= 1 / 3 ? 'near_bid' : t >= 2 / 3 ? 'near_ask' : 'middle';
  }
  if (a !== null) return price > a ? 'above_ask' : 'below_ask';
  if (b !== null) return price < b ? 'below_bid' : 'above_bid';
  return null;
}
