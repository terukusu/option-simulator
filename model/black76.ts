/**
 * Black-76（先物オプション）の価格とグリーク。設計 docs/design.md 5 章。
 *
 * c = e^{−rT} [F Φ(d1) − K Φ(d2)]、p = e^{−rT} [K Φ(−d2) − F Φ(−d1)]、
 * d1 = (ln(F/K) + σ²T/2) / (σ√T)、d2 = d1 − σ√T。
 *
 * ここでのグリークは「原資産 1 単位・σ 1.00・1 年」あたりの生の値（乗数を掛けない）。
 * 表示の単位（ラージ換算枚数・円 / 暦日・円 / 1pt）への換算は position.ts。
 * 極限（T → 0、σ → 0、K → 0 / ∞）で NaN を出さない。
 */

import { normCdf, normPdf } from './normal';

export type OptionType = 'call' | 'put';

export interface Greeks {
  /** ∂V/∂F */
  delta: number;
  /** ∂²V/∂F² */
  gamma: number;
  /** ∂V/∂σ（σ = 1.00 あたり） */
  vega: number;
  /** −∂V/∂T（暦年あたり。時間の経過による変化。買いは通常負） */
  theta: number;
}

/** 割引した本源的価値 e^{−rT} max(±(F − K), 0)。T ≤ 0 は割引なし。 */
export function discountedIntrinsic(
  type: OptionType,
  F: number,
  K: number,
  T: number,
  r: number,
): number {
  const df = T > 0 ? Math.exp(-r * T) : 1;
  if (type === 'call') return K === Number.POSITIVE_INFINITY ? 0 : df * Math.max(F - K, 0);
  if (K === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  return df * Math.max(K - F, 0);
}

/** 無裁定の上限（call は e^{−rT}F、put は e^{−rT}K）。 */
export function upperBound(type: OptionType, F: number, K: number, T: number, r: number): number {
  const df = T > 0 ? Math.exp(-r * T) : 1;
  return df * (type === 'call' ? F : K);
}

interface D12 {
  d1: number;
  d2: number;
  sd: number;
}

function d12(F: number, K: number, T: number, sigma: number): D12 | null {
  const sd = sigma * Math.sqrt(T);
  if (!(sd > 0) || !(F > 0) || !(K > 0) || !Number.isFinite(K) || !Number.isFinite(sd)) {
    return null;
  }
  const lnFK = Math.log(F / K);
  const d1 = lnFK / sd + sd / 2;
  return { d1, d2: d1 - sd, sd };
}

/** Black-76 の価格。T ≤ 0 または σ ≤ 0 のときは割引本源的価値。 */
export function black76Price(
  type: OptionType,
  F: number,
  K: number,
  T: number,
  sigma: number,
  r: number,
): number {
  if (!(T > 0) || !(sigma > 0)) return discountedIntrinsic(type, F, K, T, r);
  const df = Math.exp(-r * T);
  if (K <= 0) return type === 'call' ? df * F : 0;
  if (K === Number.POSITIVE_INFINITY) return type === 'call' ? 0 : Number.POSITIVE_INFINITY;
  if (F <= 0) return type === 'call' ? 0 : df * K;
  // d12() と同じ計算（グラフの再サンプリングで呼ばれるので割り当てを避けて展開）
  const sd = sigma * Math.sqrt(T);
  if (!(sd > 0) || !Number.isFinite(sd)) return discountedIntrinsic(type, F, K, T, r);
  const d1 = Math.log(F / K) / sd + sd / 2;
  const d2 = d1 - sd;
  // 丸め誤差で割引本源的価値を下回らないよう下限を付ける
  if (type === 'call') return df * Math.max(F * normCdf(d1) - K * normCdf(d2), F - K, 0);
  return df * Math.max(K * normCdf(-d2) - F * normCdf(-d1), K - F, 0);
}

const ZERO_GREEKS: Greeks = { delta: 0, gamma: 0, vega: 0, theta: 0 };

/**
 * 解析的なグリーク。T ≤ 0 / σ ≤ 0 では本源的価値の傾き（delta は 0 / ±e^{−rT}、他は 0）。
 * theta は F を固定した −∂V/∂T（= −e^{−rT}Fφ(d1)σ/(2√T) + rV）。
 */
export function black76Greeks(
  type: OptionType,
  F: number,
  K: number,
  T: number,
  sigma: number,
  r: number,
): Greeks {
  const d = T > 0 && sigma > 0 ? d12(F, K, T, sigma) : null;
  if (d === null) {
    if (!(F > 0) || !(K > 0) || !Number.isFinite(K)) {
      // K → 0: call は先物そのもの（δ = e^{−rT}）、put は 0。K → ∞: put は −e^{−rT}
      const df = T > 0 ? Math.exp(-r * T) : 1;
      if (K <= 0) return type === 'call' ? { ...ZERO_GREEKS, delta: df } : ZERO_GREEKS;
      if (K === Number.POSITIVE_INFINITY)
        return type === 'put' ? { ...ZERO_GREEKS, delta: -df } : ZERO_GREEKS;
      return ZERO_GREEKS;
    }
    const df = T > 0 ? Math.exp(-r * T) : 1;
    const itm = type === 'call' ? F > K : F < K;
    return { ...ZERO_GREEKS, delta: itm ? (type === 'call' ? df : -df) : 0 };
  }
  const df = Math.exp(-r * T);
  const pdf = normPdf(d.d1);
  const sqrtT = Math.sqrt(T);
  const price = black76Price(type, F, K, T, sigma, r);
  const delta = type === 'call' ? df * normCdf(d.d1) : -df * normCdf(-d.d1);
  const gamma = (df * pdf) / (F * d.sd);
  const vega = df * F * pdf * sqrtT;
  const theta = (-df * F * pdf * sigma) / (2 * sqrtT) + r * price;
  return { delta, gamma, vega, theta };
}
