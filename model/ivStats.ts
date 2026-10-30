/**
 * IV と原資産の動きの統計（#138・#158。docs/design.md 13.4「AI のツール iv_stats」）。AI のツール `iv_stats`
 * （ui/view/aiIvStats.ts）が日次の値（/api/atm_daily の 30 日固定の ATM IV と同じ限月のフォワード）から計算する純関数
 * （DOM・通信・時計・乱数に依存しない）。
 *
 * - 分位（percentileRank）: v 以下の個数 / n × 100（経験分布）。分位点は model/technicals.ts の quantile（線形補間）
 * - スパイク（ivSpikes）: 日次の終値の列 iv。low_i = 直前 lookback 行の最小（行が足りない i は候補にしない）。
 *   iv[i] ≥ low_i × (1 + rise) の最初の i が起点（起点の最低 b = low_i）。i から先で走る最高 p を更新し、
 *   iv[j] ≤ b + 0.5(p − b) の最初の j が半分戻し（山 = それまでの最高の行。同じ値なら最初）。その後
 *   iv ≤ b + 0.1(p − b) の最初の行が 9 割戻し（次の回の起点より前に無ければ null = 9 割は戻らないまま次の
 *   スパイクが来た。最後の回は列の終わりまで）。次の起点は半分戻しの次の行から探す。
 *   半分戻しが無いまま列が終われば ongoing（山は今までの最高）。日数は行の差（データのある取引日で数える）
 * - β（ivBeta）: 組 (x = 原資産の変化 %, y = IV の変化 pt) の最小二乗の傾き s の −s（pt / 1%。下げで IV が上がると正）。
 *   シナリオの β（実測の形の倍率。docs/design.md 5.4・5.13）とは単位も量も違う。下げ（dx < 0）・上げ（dx > 0）・全体
 * - 実現ボラ（realizedVol）: 対数変化 r の最後の n 本の平均 0 の二乗平均を年率にした値
 *   sqrt(daysPerYear / n × Σ r²)（小数。0.18 = 18%）。年の取引日は HV_DAYS_PER_YEAR（245）
 */

import { quantile } from './technicals';

/** 年の取引日（実現ボラの年率化。日本の取引所のおおよその取引日数） */
export const HV_DAYS_PER_YEAR = 245;
/** スパイクの起点の最低を取る行数（取引日） */
export const SPIKE_LOOKBACK = 10;
/** 半分戻し・9 割戻しの比（山と起点の最低の間の、戻した割合） */
export const SPIKE_HALF = 0.5;
export const SPIKE_RETRACE90 = 0.9;

/** 経験分布の順位（v 以下の割合 × 100。sorted は昇順。空・v が有限でなければ null） */
export function percentileRank(sorted: readonly number[], v: number): number | null {
  const n = sorted.length;
  if (n === 0 || !Number.isFinite(v)) return null;
  // v 以下の個数 = v より大きい最初の位置（二分探索）
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) <= v) lo = mid + 1;
    else hi = mid;
  }
  return (lo / n) * 100;
}

/** 昇順に並べた写し（有限の値だけ） */
export const sortedFinite = (xs: readonly number[]): number[] =>
  xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);

export interface Quantiles {
  n: number;
  min: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
}

/** 分布の要約（sorted は昇順） */
export function quantilesOf(sorted: readonly number[]): Quantiles {
  const n = sorted.length;
  return {
    n,
    min: n > 0 ? (sorted[0] as number) : null,
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    max: n > 0 ? (sorted[n - 1] as number) : null,
  };
}

/** スパイクの 1 回（位置は iv の行の番号） */
export interface IvSpike {
  /** 起点（low × (1 + rise) 以上になった最初の行） */
  start: number;
  /** 起点の最低（直前 lookback 行の最小） */
  base: number;
  /** 山の行 */
  peak: number;
  /** 半分戻しの行（ongoing なら null） */
  half: number | null;
  /** 9 割戻しの行（次の回の起点より前・列の中に無ければ null） */
  retrace90: number | null;
  /** 半分戻しが無いまま列が終わった */
  ongoing: boolean;
}

/** 直前 lookback 行の最小（行が足りない・有限でない値を含むなら null） */
export function lowBefore(
  iv: readonly number[],
  i: number,
  lookback = SPIKE_LOOKBACK,
): number | null {
  if (i < lookback || lookback < 1) return null;
  let m = Number.POSITIVE_INFINITY;
  for (let j = i - lookback; j < i; j++) {
    const v = iv[j] as number;
    if (!Number.isFinite(v)) return null;
    if (v < m) m = v;
  }
  return m;
}

/** スパイクの検出（rise は比。0.3 = 直前の最低から 30% 以上の上昇） */
export function ivSpikes(
  iv: readonly number[],
  rise: number,
  lookback = SPIKE_LOOKBACK,
): IvSpike[] {
  const out: IvSpike[] = [];
  const n = iv.length;
  if (!(rise > 0)) return out;
  let i = lookback;
  while (i < n) {
    const low = lowBefore(iv, i, lookback);
    const v = iv[i] as number;
    if (low === null || !(low > 0) || !Number.isFinite(v) || v < low * (1 + rise)) {
      i++;
      continue;
    }
    let peak = i;
    let half: number | null = null;
    for (let j = i + 1; j < n; j++) {
      const x = iv[j] as number;
      if (!Number.isFinite(x)) continue;
      if (x > (iv[peak] as number)) peak = j;
      else if (x <= low + SPIKE_HALF * ((iv[peak] as number) - low)) {
        half = j;
        break;
      }
    }
    let retrace90: number | null = null;
    if (half !== null) {
      const lvl = low + (1 - SPIKE_RETRACE90) * ((iv[peak] as number) - low);
      for (let j = half; j < n; j++) {
        if ((iv[j] as number) <= lvl) {
          retrace90 = j;
          break;
        }
      }
    }
    out.push({ start: i, base: low, peak, half, retrace90, ongoing: half === null });
    if (half === null) break;
    i = half + 1;
  }
  // 9 割戻しの探索は次の回の起点の前まで（次のスパイクの下げを前の回の戻りに数えない）
  for (let k = 0; k + 1 < out.length; k++) {
    const e = out[k] as IvSpike;
    if (e.retrace90 !== null && e.retrace90 >= (out[k + 1] as IvSpike).start) e.retrace90 = null;
  }
  return out;
}

/** 最小二乗の傾き（x の分散が 0・組が 2 未満・有限でない値は null） */
export function regressionSlope(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i] as number;
    sy += ys[i] as number;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    sxx += dx * dx;
    sxy += dx * ((ys[i] as number) - my);
  }
  const s = sxy / sxx;
  return sxx > 0 && Number.isFinite(s) ? s : null;
}

/** β の計算に使う組（dx は比 = −0.05 は −5%、ivPt は IV の変化の pt） */
export interface MovePoint {
  dx: number;
  ivPt: number;
}

export interface IvBeta {
  /** 下げ（dx < 0）の β（pt / 1%）。組が minN 未満なら null */
  down: number | null;
  up: number | null;
  all: number | null;
  nDown: number;
  nUp: number;
  nAll: number;
}

/** 実測の β（−傾き。pt / 1%）。組が minN 未満の側は null */
export function ivBeta(moves: readonly MovePoint[], minN = 2): IvBeta {
  const ok = moves.filter((m) => Number.isFinite(m.dx) && Number.isFinite(m.ivPt));
  const beta = (ms: readonly MovePoint[]) => {
    if (ms.length < Math.max(minN, 2)) return null;
    const s = regressionSlope(
      ms.map((m) => m.dx * 100),
      ms.map((m) => m.ivPt),
    );
    return s === null ? null : -s || 0;
  };
  const down = ok.filter((m) => m.dx < 0);
  const up = ok.filter((m) => m.dx > 0);
  return {
    down: beta(down),
    up: beta(up),
    all: beta(ok),
    nDown: down.length,
    nUp: up.length,
    nAll: ok.length,
  };
}

/** 実現ボラ（最後の n 本の対数変化。年率の小数。本数が足りない・有限でない値を含むなら null） */
export function realizedVol(
  logRets: readonly number[],
  n: number,
  daysPerYear = HV_DAYS_PER_YEAR,
  end = logRets.length,
): number | null {
  if (!(n >= 1) || end < n || end > logRets.length) return null;
  let s = 0;
  for (let i = end - n; i < end; i++) {
    const r = logRets[i] as number;
    if (!Number.isFinite(r)) return null;
    s += r * r;
  }
  return Math.sqrt((daysPerYear / n) * s);
}

/** 実現ボラの列（位置 i = 最後が i の n 本。足りない先頭は null） */
export function rollingVol(
  logRets: readonly number[],
  n: number,
  daysPerYear = HV_DAYS_PER_YEAR,
): (number | null)[] {
  return logRets.map((_, i) => realizedVol(logRets, n, daysPerYear, i + 1));
}
