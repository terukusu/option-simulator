/**
 * テクニカル指標と基準率（#200。docs/design.md 13.4「テクニカル指標」）。先物推移の段（画面）と AI のツール `technicals`
 * で共用する純関数（DOM・通信・時計・乱数に依存しない）。値の配列は入力と同じ長さで、計算できない（足りない）位置は null。
 * どの値も その位置までのデータだけで決まる（先読みしない）。
 *
 * - EMA(n): α = 2 / (n + 1)。最初の n 個の単純平均で始める（TA-Lib と同じ）。最初の値は index n − 1
 * - RSI(14): Wilder の平滑。最初の 14 個の変化の上げ・下げの単純平均で始め、以後 avg = (avg·13 + x) / 14。
 *   RSI = 100 − 100 / (1 + 上げの平均 / 下げの平均)。下げの平均が 0 なら 100（上げも 0 なら 50）。最初の値は index 14
 * - MACD(12, 26, 9): MACD = EMA12 − EMA26（index 25 から）、シグナル = MACD の EMA9（MACD の最初の 9 個の平均で始める。
 *   index 33 から）、ヒストグラム = MACD − シグナル
 * - スロー・ストキャスティクス(14, 3, 3): 生の %K = 100·(C − 14 本の最安値) / (14 本の最高値 − 最安値)（幅 0 → 50）、
 *   スロー %K = 生の %K の 3 本の単純平均、%D = スロー %K の 3 本の単純平均。最初の値はスロー %K が index 15、%D が 17
 * - 基準率（baseRate）: 過去の足 j のうち条件を満たすものを左から選び、N 本先の騰落率 c[j+N] / c[j] − 1 を集める。
 *   窓は重ねない（次の候補は j + N 以降）。結果に使う足は lastUsable まで（確定前の最後の足を使わない）
 * - 期間は #205 で設定から変えられる（TechParams。上の数は既定 DEFAULT_TECH_PARAMS の場合）
 */

export type Series = (number | null)[];

export const RSI_PERIOD = 14;
export const MACD_FAST = 12;
export const MACD_SLOW = 26;
export const MACD_SIGNAL = 9;
export const STOCH_K = 14;
export const STOCH_SMOOTH = 3;
export const STOCH_D = 3;

/** ゾーンの閾値（RSI 70 / 30、ストキャスティクス 80 / 20） */
export const RSI_HIGH = 70;
export const RSI_LOW = 30;
export const STOCH_HIGH = 80;
export const STOCH_LOW = 20;

/** 基準率の件数の下限（これ未満は insufficient = サンプル不足） */
export const BASE_RATE_MIN_N = 20;

const nulls = (n: number): Series => new Array<number | null>(n).fill(null);

/** 単純移動平均（null を含む窓は null） */
export function sma(values: readonly (number | null)[], period: number): Series {
  const n = values.length;
  const out = nulls(n);
  if (!(period >= 1)) return out;
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || v === undefined) valid = 0;
    else valid++;
    sum += v ?? 0;
    const old = i >= period ? values[i - period] : null;
    if (i >= period) sum -= old ?? 0;
    if (valid >= period) out[i] = sum / period;
  }
  return out;
}

/**
 * 指数移動平均（α = 2 / (period + 1)、最初の period 個の単純平均で始める）。先頭の null は飛ばし（そこから数え始める）、
 * 途中の null は以後を null にする
 */
export function ema(values: readonly (number | null)[], period: number): Series {
  const n = values.length;
  const out = nulls(n);
  if (!(period >= 1)) return out;
  const a = 2 / (period + 1);
  let start = 0;
  while (start < n && values[start] === null) start++;
  if (start + period > n) return out;
  let sum = 0;
  for (let i = start; i < start + period; i++) {
    const v = values[i];
    if (v === null || v === undefined) return out;
    sum += v;
  }
  let prev = sum / period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < n; i++) {
    const v = values[i];
    if (v === null || v === undefined) return out;
    prev = a * v + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}

/** RSI（Wilder の平滑） */
export function rsi(closes: readonly number[], period = RSI_PERIOD): Series {
  const n = closes.length;
  const out = nulls(n);
  if (!(period >= 1) || n <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const val = (g: number, l: number) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
  out[period] = val(gain, loss);
  for (let i = period + 1; i < n; i++) {
    const d = (closes[i] as number) - (closes[i - 1] as number);
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = val(gain, loss);
  }
  return out;
}

export interface MacdSeries {
  macd: Series;
  signal: Series;
  hist: Series;
}

/** MACD（EMA fast − EMA slow、シグナル = MACD の EMA） */
export function macd(
  closes: readonly number[],
  fast = MACD_FAST,
  slow = MACD_SLOW,
  signalPeriod = MACD_SIGNAL,
): MacdSeries {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line: Series = f.map((v, i) => {
    const w = s[i];
    return v === null || w === null || w === undefined ? null : v - w;
  });
  const signal = ema(line, signalPeriod);
  const hist: Series = line.map((v, i) => {
    const g = signal[i];
    return v === null || g === null || g === undefined ? null : v - g;
  });
  return { macd: line, signal, hist };
}

export interface StochSeries {
  k: Series;
  d: Series;
}

/** スロー・ストキャスティクス（生の %K → スロー %K = SMA、%D = スロー %K の SMA） */
export function stochastic(
  bars: readonly { h: number; l: number; c: number }[],
  kPeriod = STOCH_K,
  smooth = STOCH_SMOOTH,
  dPeriod = STOCH_D,
): StochSeries {
  const n = bars.length;
  const raw = nulls(n);
  for (let i = kPeriod - 1; i < n; i++) {
    let hi = Number.NEGATIVE_INFINITY;
    let lo = Number.POSITIVE_INFINITY;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      const b = bars[j] as { h: number; l: number };
      if (b.h > hi) hi = b.h;
      if (b.l < lo) lo = b.l;
    }
    const c = (bars[i] as { c: number }).c;
    raw[i] = hi > lo ? (100 * (c - lo)) / (hi - lo) : 50;
  }
  const k = sma(raw, smooth);
  return { k, d: sma(k, dPeriod) };
}

// ---------------------------------------------------------------- パラメータ（#205）

/**
 * 3 つの指標の期間（#205。設定のダイアログで変えられる。端末の設定 ui/prefs.ts に保存し、先物推移の段と AI のツール
 * technicals の両方に同じ値を渡す）。stochSmooth = スロー %K の平滑（slowing）
 */
export interface TechParams {
  rsi: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  stochK: number;
  stochSmooth: number;
  stochD: number;
}

export type TechParamKey = keyof TechParams;

export const DEFAULT_TECH_PARAMS: Readonly<TechParams> = Object.freeze({
  rsi: RSI_PERIOD,
  macdFast: MACD_FAST,
  macdSlow: MACD_SLOW,
  macdSignal: MACD_SIGNAL,
  stochK: STOCH_K,
  stochSmooth: STOCH_SMOOTH,
  stochD: STOCH_D,
});

/** 欄の並び（設定のダイアログ・保存の順） */
export const TECH_PARAM_KEYS: readonly TechParamKey[] = [
  'rsi',
  'macdFast',
  'macdSlow',
  'macdSignal',
  'stochK',
  'stochSmooth',
  'stochD',
];

/**
 * 期間の範囲（両端を含む整数）。上限 100 は AI の中継の結果の検査（tools.py の TECHNICALS.params = 整数 1〜100）に
 * 合わせる（中継のスキーマを変えない）。平滑・%D は 1（= 平滑しない）から
 */
export const TECH_PARAM_RANGE: Record<TechParamKey, { min: number; max: number }> = {
  rsi: { min: 2, max: 100 },
  macdFast: { min: 2, max: 100 },
  macdSlow: { min: 2, max: 100 },
  macdSignal: { min: 2, max: 100 },
  stochK: { min: 2, max: 100 },
  stochSmooth: { min: 1, max: 20 },
  stochD: { min: 1, max: 20 },
};

/** 1 つの期間が範囲内の整数か */
export function isTechParamValue(key: TechParamKey, v: unknown): v is number {
  if (typeof v !== 'number' || !Number.isInteger(v)) return false;
  const r = TECH_PARAM_RANGE[key];
  return v >= r.min && v <= r.max;
}

/** 期間の組が使えるか（どれも範囲内、MACD は短期 < 長期） */
export function isTechParams(p: unknown): p is TechParams {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  if (!TECH_PARAM_KEYS.every((k) => isTechParamValue(k, o[k]))) return false;
  return (o.macdFast as number) < (o.macdSlow as number);
}

/** 期間の組が同じか */
export function sameTechParams(a: TechParams, b: TechParams): boolean {
  return TECH_PARAM_KEYS.every((k) => a[k] === b[k]);
}

/** 3 つの指標をまとめて計算する（画面の段と AI のツールで同じ値）。params = 計算に使った期間（見出し・ツールの出力に出す） */
export interface Indicators {
  rsi: Series;
  macd: MacdSeries;
  stoch: StochSeries;
  params: TechParams;
}

export function indicators(
  bars: readonly { h: number; l: number; c: number }[],
  params: TechParams = DEFAULT_TECH_PARAMS,
): Indicators {
  const closes = bars.map((b) => b.c);
  return {
    rsi: rsi(closes, params.rsi),
    macd: macd(closes, params.macdFast, params.macdSlow, params.macdSignal),
    stoch: stochastic(bars, params.stochK, params.stochSmooth, params.stochD),
    params: { ...params },
  };
}

// ---------------------------------------------------------------- 状態

export type Zone = 'high' | 'low' | 'mid';

export function zoneOf(v: number | null | undefined, high: number, low: number): Zone | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return v >= high ? 'high' : v <= low ? 'low' : 'mid';
}

/** i の時点で同じゾーンが何本続いているか（i を含む。i が null なら 0） */
export function barsInZone(
  values: readonly (number | null)[],
  i: number,
  high: number,
  low: number,
): number {
  const z = zoneOf(values[i], high, low);
  if (z === null) return 0;
  let k = 0;
  for (let j = i; j >= 0 && zoneOf(values[j], high, low) === z; j--) k++;
  return k;
}

/**
 * i の時点で a − b の符号（≥ 0 を上）が同じになってから何本目か（交差の足 = 1）。a > b なら above = true。
 * 符号が変わった足が見えている範囲に無ければ crossed = false（本数は値のある足の数）
 */
export function sinceCross(
  a: readonly (number | null)[],
  b: readonly (number | null)[],
  i: number,
): { above: boolean; bars: number; crossed: boolean } | null {
  const diff = (j: number) => {
    const x = a[j];
    const y = b[j];
    return x === null || x === undefined || y === null || y === undefined ? null : x - y;
  };
  const d0 = diff(i);
  if (d0 === null) return null;
  const above = d0 >= 0;
  let k = 0;
  for (let j = i; j >= 0; j--) {
    const d = diff(j);
    if (d === null) return { above, bars: k, crossed: false };
    if (d >= 0 !== above) return { above, bars: k, crossed: true };
    k++;
  }
  return { above, bars: k, crossed: false };
}

// ---------------------------------------------------------------- 基準率

export interface BaseRate {
  /** 件数（重ならない窓の数） */
  n: number;
  /** N 本先の騰落率（%）の中央値・10%・90% 分位（n = 0 なら null） */
  median: number | null;
  p10: number | null;
  p90: number | null;
  /** n < BASE_RATE_MIN_N */
  insufficient: boolean;
  /** 条件に合ったが valid で除いた窓の数（先物の限月交代をまたぐ窓など） */
  excluded: number;
}

/** 分位（線形補間。sorted は昇順。空なら null） */
export function quantile(sorted: readonly number[], q: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const pos = (n - 1) * Math.min(Math.max(q, 0), 1);
  const i = Math.floor(pos);
  const f = pos - i;
  const a = sorted[i] as number;
  const b = sorted[Math.min(i + 1, n - 1)] as number;
  return a + (b - a) * f;
}

/**
 * 基準率: 条件 match(j) を満たす j（0 ≤ j、j + horizon ≤ lastUsable）を左から選び（窓を重ねない = 次は j + horizon 以降）、
 * 騰落率 100·(c[j+horizon] / c[j] − 1)（%）の件数・中央値・p10・p90。match は j までのデータだけで決まる状態にする。
 * valid(j, j + horizon) が false の窓（例: 先物の限月交代をまたぐ = つなぎ足の跳びが騰落率に入る）は数えずに除き
 * （excluded に数える）、次の j を見る
 */
export function baseRate(
  closes: readonly number[],
  horizon: number,
  lastUsable: number,
  match: (j: number) => boolean,
  valid: (j0: number, j1: number) => boolean = () => true,
): BaseRate {
  const rets: number[] = [];
  let excluded = 0;
  if (horizon >= 1) {
    for (let j = 0; j + horizon <= lastUsable && j + horizon < closes.length; j++) {
      if (!match(j)) continue;
      if (!valid(j, j + horizon)) {
        excluded++;
        continue;
      }
      const c0 = closes[j] as number;
      const c1 = closes[j + horizon] as number;
      if (!(c0 > 0) || !Number.isFinite(c1)) continue;
      rets.push((c1 / c0 - 1) * 100);
      j += horizon - 1;
    }
  }
  rets.sort((x, y) => x - y);
  return {
    n: rets.length,
    median: quantile(rets, 0.5),
    p10: quantile(rets, 0.1),
    p90: quantile(rets, 0.9),
    insufficient: rets.length < BASE_RATE_MIN_N,
    excluded,
  };
}
