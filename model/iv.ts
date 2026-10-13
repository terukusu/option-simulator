/**
 * IV の逆算（Newton + 二分法の囲い込み）と IV の分解能の帯。設計 docs/design.md 5.3・9 章。
 *
 * 解の存在範囲: 割引本源的価値 < 価格 < 上限（call は e^{−rT}F、put は e^{−rT}K）。
 * その外、または T ≤ T_min は「解なし」。
 */

import {
  black76Greeks,
  black76Price,
  discountedIntrinsic,
  type OptionType,
  upperBound,
} from './black76';
import { T_MIN_YEARS } from './time';

export type IvFailure = 'below_intrinsic' | 'above_upper' | 'expired' | 'invalid';

export type IvResult =
  | { ok: true; sigma: number; iterations: number }
  | { ok: false; reason: IvFailure };

export interface IvOptions {
  /** T がこれ以下なら解なし（既定 T_min = 1 分） */
  tMin?: number;
  /** σ の許容誤差（既定 1e-10。設計の要求は 1e-6） */
  sigmaTol?: number;
  maxIterations?: number;
}

const SIGMA_LO = 1e-8;
const SIGMA_HI_MAX = 1e3;

/** 価格から IV を逆算する。 */
export function impliedVol(
  type: OptionType,
  price: number,
  F: number,
  K: number,
  T: number,
  r: number,
  opts: IvOptions = {},
): IvResult {
  const tMin = opts.tMin ?? T_MIN_YEARS;
  const tol = opts.sigmaTol ?? 1e-10;
  const maxIter = opts.maxIterations ?? 200;
  if (![price, F, K, T, r].every(Number.isFinite) || F <= 0 || K <= 0) {
    return { ok: false, reason: 'invalid' };
  }
  if (T <= tMin) return { ok: false, reason: 'expired' };
  const lower = discountedIntrinsic(type, F, K, T, r);
  const upper = upperBound(type, F, K, T, r);
  if (price <= lower) return { ok: false, reason: 'below_intrinsic' };
  if (price >= upper) return { ok: false, reason: 'above_upper' };

  const f = (s: number) => black76Price(type, F, K, T, s, r) - price;
  // 囲い込み [lo, hi]: f(lo) < 0 < f(hi)
  let lo = SIGMA_LO;
  let hi = 2;
  if (f(lo) >= 0) return { ok: true, sigma: lo, iterations: 0 };
  while (f(hi) <= 0) {
    lo = hi;
    hi *= 2;
    if (hi > SIGMA_HI_MAX) return { ok: false, reason: 'above_upper' };
  }
  // 初期値: Brenner–Subrahmanyam（ATM 近似）を囲いに収める
  const atmGuess = (Math.sqrt((2 * Math.PI) / T) * price) / (Math.exp(-r * T) * F);
  let s = Math.min(Math.max(atmGuess, lo), hi);
  if (!(s > lo && s < hi)) s = 0.5 * (lo + hi);
  for (let i = 1; i <= maxIter; i++) {
    const v = f(s);
    if (v === 0) return { ok: true, sigma: s, iterations: i };
    if (v < 0) lo = s;
    else hi = s;
    const vega = black76Greeks(type, F, K, T, s, r).vega;
    let next = vega > 0 ? s - v / vega : Number.NaN;
    // Newton の一歩が囲いの外に出る / 進まないときは二分法
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    const step = Math.abs(next - s);
    s = next;
    if (step <= tol * Math.max(1, s) || hi - lo <= tol) {
      return { ok: true, sigma: s, iterations: i };
    }
  }
  return { ok: true, sigma: s, iterations: maxIter };
}

export interface IvBand {
  /** price − halfWidth に対応する IV（下限を割るなら 0） */
  lo: number;
  /** price + halfWidth に対応する IV（上限を超えるなら Infinity） */
  hi: number;
  /** hi − lo（σ 単位。5pt = 0.05） */
  width: number;
}

/**
 * IV の分解能の帯: 価格 [p − h, p + h]（既定 h = 0.5 円）に対応する IV の幅（設計 5.3）。
 * T ≤ T_min など両端とも解けないときは null。
 */
export function ivResolutionBand(
  type: OptionType,
  price: number,
  F: number,
  K: number,
  T: number,
  r: number,
  halfWidth = 0.5,
  opts: IvOptions = {},
): IvBand | null {
  const a = impliedVol(type, price - halfWidth, F, K, T, r, opts);
  const b = impliedVol(type, price + halfWidth, F, K, T, r, opts);
  const lo = a.ok ? a.sigma : a.reason === 'below_intrinsic' ? 0 : null;
  const hi = b.ok ? b.sigma : b.reason === 'above_upper' ? Number.POSITIVE_INFINITY : null;
  if (lo === null || hi === null) return null;
  return { lo, hi, width: hi - lo };
}
