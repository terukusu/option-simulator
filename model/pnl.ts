/**
 * 満期損益の区分線形の解析解、理論損益の BEP、テール表。設計 docs/design.md 5.5・5.6。
 *
 * 満期損益: 全オプションの足をそれぞれの SQ で評価する（SQ_i = X' + basis_i、% モードは X' × F_i / X₀）。
 * 各足は X' の 1 次式 a·X' + b の関数なので、合計は区分線形で折れ点は (K − b) / a（円モードは K − basis_i）。
 * 先物の足は「オプションの最後の SQ」の時点で評価する（basis 固定 / 減衰、先物の SQ を過ぎていれば F = X'）。
 * 横軸の下端は全足の原資産が 0 以上になる点 X_lo = max(0, max_i(−b_i / a_i))（put 売りの最大損失は SQ = 0）。
 */

import {
  DEFAULT_SETTINGS,
  type MarketContext,
  type ModelSettings,
  type PreparedLeg,
  premiumSummary,
  theoreticalPnl,
} from './position';
import type { Scenario } from './scenario';

interface LinearLeg {
  kind: 'call' | 'put' | 'linear';
  /** 原資産 = a·X' + b */
  a: number;
  b: number;
  k: number;
  /** 符号 × 枚数 × 乗数 */
  w: number;
  entry: number;
  fee: number;
}

export interface ExpiryPoint {
  x: number;
  pnl: number;
}

export interface Extremum {
  /** 値（円）。±Infinity なら無限 */
  value: number;
  /** 達成する X'（無限なら null） */
  x: number | null;
}

export interface ExpiryProfile {
  /** 横軸の下端 X_lo と、それより右の折れ点（昇順）での損益 */
  points: ExpiryPoint[];
  /** 折れ点（K − basis_i 等。下端より左のものも含む、重複なし昇順） */
  kinks: number[];
  /** 下端での傾き（最初の区間）と右端の傾き（X' → ∞）。円 / 円 */
  leftSlope: number;
  rightSlope: number;
  maxProfit: Extremum;
  maxLoss: Extremum;
  /**
   * 下端と折れ点の中での最小（有限）。右端が −∞ でも put 側（下落側）の最大損失を出すのに使う
   * （設計 6.1 の「最大損失 −62,195,000（put 側、SQ=0）/ call 側 ∞」）
   */
  worstAtKinks: Extremum;
  bestAtKinks: Extremum;
  /** 損益分岐点（1 円単位に丸め、昇順） */
  breakevens: number[];
  /** 満期の評価時刻（オプションの最後の SQ）。足が無ければ NaN */
  expiryTime: number;
}

function toLinearLegs(legs: readonly PreparedLeg[], ctx: MarketContext, settings: ModelSettings) {
  const optionLegs = legs.filter((p) => p.leg.kind === 'option');
  const expiryTime =
    optionLegs.length > 0
      ? Math.max(...optionLegs.map((p) => p.expiryTime))
      : legs.length > 0
        ? Math.max(...legs.map((p) => p.expiryTime))
        : Number.NaN;
  const yen = settings.basisMode === 'yen';
  const out: LinearLeg[] = legs.map((p) => {
    const w = p.sign * p.leg.qty * p.multiplier;
    const fee = settings.feePerLot * p.leg.qty;
    if (!Number.isFinite(p.F)) {
      // 原資産が決まらない足は建値のまま（損益 0。NaN を広げない。position.ts の no_forward と同じ）
      return { kind: 'linear', a: 0, b: p.leg.entry, k: 0, w, entry: p.leg.entry, fee };
    }
    if (p.leg.kind === 'option') {
      const a = yen ? 1 : p.F / ctx.x0;
      const b = yen ? p.basis : 0;
      return { kind: p.leg.type, a, b, k: p.leg.strike, w, entry: p.leg.entry, fee };
    }
    // 先物: 満期の評価時刻での価格。その時点で先物の SQ に達していれば F = X'（evaluateLeg と同じ）
    const remaining = (p.expiryTime - expiryTime) / (365 * 86_400_000);
    if (remaining <= 0) return { kind: 'linear', a: 1, b: 0, k: 0, w, entry: p.leg.entry, fee };
    const factor = settings.futureBasis === 'decay' && p.T0 > 0 ? Math.min(remaining / p.T0, 1) : 1;
    if (yen) return { kind: 'linear', a: 1, b: p.basis * factor, k: 0, w, entry: p.leg.entry, fee };
    return {
      kind: 'linear',
      a: 1 + (p.F / ctx.x0 - 1) * factor,
      b: 0,
      k: 0,
      w,
      entry: p.leg.entry,
      fee,
    };
  });
  return { linear: out, expiryTime };
}

function payoffSum(legs: readonly LinearLeg[], x: number): number {
  let s = 0;
  for (const l of legs) {
    const u = l.a * x + l.b;
    const v =
      l.kind === 'call' ? Math.max(u - l.k, 0) : l.kind === 'put' ? Math.max(l.k - u, 0) : u;
    s += l.w * (v - l.entry) - l.fee;
  }
  return s;
}

/** 満期損益の区分線形プロファイル（解析解）。 */
export function expiryProfile(
  legs: readonly PreparedLeg[],
  ctx: MarketContext,
  settings: ModelSettings = DEFAULT_SETTINGS,
): ExpiryProfile {
  const { linear, expiryTime } = toLinearLegs(legs, ctx, settings);
  const xLo = Math.max(0, ...linear.map((l) => -l.b / l.a));
  const kinks = [
    ...new Set(linear.filter((l) => l.kind !== 'linear').map((l) => (l.k - l.b) / l.a)),
  ].sort((a, b) => a - b);
  const xs = [xLo, ...kinks.filter((k) => k > xLo)];
  const points = xs.map((x) => ({ x, pnl: payoffSum(linear, x) }));
  // 右端の傾き: call と線形の足の a·w の和。左端（最初の区間）の傾きは区間内の 2 点から
  let rightSlope = 0;
  for (const l of linear) if (l.kind !== 'put') rightSlope += l.w * l.a;
  const firstEnd = xs.length > 1 ? (xs[1] as number) : xLo + 1;
  const leftSlope = (payoffSum(linear, firstEnd) - payoffSum(linear, xLo)) / (firstEnd - xLo);

  let maxP: Extremum = { value: Number.NEGATIVE_INFINITY, x: null };
  let maxL: Extremum = { value: Number.POSITIVE_INFINITY, x: null };
  for (const p of points) {
    if (p.pnl > maxP.value) maxP = { value: p.pnl, x: p.x };
    if (p.pnl < maxL.value) maxL = { value: p.pnl, x: p.x };
  }
  const bestAtKinks = maxP;
  const worstAtKinks = maxL;
  const eps = 1e-9;
  if (rightSlope > eps) maxP = { value: Number.POSITIVE_INFINITY, x: null };
  if (rightSlope < -eps) maxL = { value: Number.NEGATIVE_INFINITY, x: null };

  const profile: ExpiryProfile = {
    points,
    kinks,
    leftSlope,
    rightSlope,
    maxProfit: maxP,
    maxLoss: maxL,
    worstAtKinks,
    bestAtKinks,
    breakevens: [],
    expiryTime,
  };
  profile.breakevens = expiryCrossings(profile, 0);
  return profile;
}

/**
 * 満期損益 = level になる X'（1 円単位に丸め、昇順、重複なし）。BEP は level = 0。
 * 区分線形の区間（下端〜折れ点、折れ点の間、最後の折れ点より右の半直線）ごとに 1 次式で解く。
 * 「利益が掛け金の N 倍になる原資産」（設計 5.6、AC15 (b)）にも使う。level が非有限なら []。
 */
export function expiryCrossings(profile: ExpiryProfile, level: number): number[] {
  if (!Number.isFinite(level)) return [];
  const pts = profile.points;
  const eps = 1e-9;
  const out: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as ExpiryPoint;
    const dp = p.pnl - level;
    if (dp === 0) out.push(p.x);
    const q = pts[i + 1];
    if (!q) continue;
    const dq = q.pnl - level;
    if (dp * dq < 0) out.push(p.x + (-dp * (q.x - p.x)) / (q.pnl - p.pnl));
  }
  const last = pts[pts.length - 1];
  if (last) {
    const dl = last.pnl - level;
    const slope = profile.rightSlope;
    if (dl !== 0 && Math.abs(slope) > eps && Math.sign(dl) !== Math.sign(slope)) {
      out.push(last.x - dl / slope);
    }
  }
  return [...new Set(out.map((x) => Math.round(x)))].sort((a, b) => a - b);
}

/** 満期損益の関数を作る（グラフの再サンプリング用。足の 1 次式への変換を 1 回だけ行う）。 */
export function expiryPnlFn(
  legs: readonly PreparedLeg[],
  ctx: MarketContext,
  settings: ModelSettings = DEFAULT_SETTINGS,
): (xPrime: number) => number {
  const { linear } = toLinearLegs(legs, ctx, settings);
  return (x) => payoffSum(linear, x);
}

/** 満期損益を任意の X' で（グラフ・テール表の SQ 列）。 */
export function expiryPnl(
  legs: readonly PreparedLeg[],
  xPrime: number,
  ctx: MarketContext,
  settings: ModelSettings = DEFAULT_SETTINGS,
): number {
  return payoffSum(toLinearLegs(legs, ctx, settings).linear, xPrime);
}

/**
 * 連続関数 f の [lo, hi] 内の零点（符号変化）を、n 等分で囲ってから二分法で 1 円まで求める。
 * 結果は 1 円単位に丸める。
 */
export function findBreakevens(
  f: (x: number) => number,
  lo: number,
  hi: number,
  n = 512,
): number[] {
  const out: number[] = [];
  const step = (hi - lo) / n;
  let xa = lo;
  let fa = f(xa);
  if (fa === 0) out.push(xa);
  for (let i = 1; i <= n; i++) {
    const xb = i === n ? hi : lo + step * i;
    const fb = f(xb);
    if (fb === 0) out.push(xb);
    else if (fa * fb < 0) {
      let a = xa;
      let b = xb;
      let va = fa;
      while (b - a > 0.5) {
        const m = 0.5 * (a + b);
        const vm = f(m);
        if (vm === 0) {
          a = m;
          b = m;
          break;
        }
        if (va * vm < 0) b = m;
        else {
          a = m;
          va = vm;
        }
      }
      out.push(0.5 * (a + b));
    }
    xa = xb;
    fa = fb;
  }
  return [...new Set(out.map((x) => Math.round(x)))];
}

/** 指定日（シナリオ込み）の理論損益の BEP。 */
export function theoreticalBreakevens(
  legs: readonly PreparedLeg[],
  scenario: Scenario,
  ctx: MarketContext,
  range: { lo: number; hi: number },
  settings: ModelSettings = DEFAULT_SETTINGS,
  samples = 512,
): number[] {
  return findBreakevens(
    (x) => theoreticalPnl(legs, x, scenario, ctx, settings),
    range.lo,
    range.hi,
    samples,
  );
}

// ---------------------------------------------------------------- テール表

export const TAIL_SHOCKS = [-0.05, -0.1, -0.2, -0.3, -0.4] as const;

export interface TailCell {
  pnl: number;
  /** pnl / 基準プレミアム（基準が 0 なら null） */
  ratio: number | null;
}

export interface TailRow {
  shock: number;
  /** X' = X₀ × (1 + shock) */
  x: number;
  /** SQ（満期損益の式） */
  sq: TailCell;
  /** 指定日 + シナリオ IV（β 込み） */
  scenario: TailCell;
}

export interface TailTable {
  /**
   * 倍率の基準: 受取超（net > 0）なら受取 − 支払（手数料抜き。設計 6.1 の例）、
   * それ以外は掛け金 = 支払 − 受取 + 手数料（全足。#6）。net = 0 なら掛け金も 0 とし倍率を出さない
   */
  premiumBase: { kind: 'received' | 'paid'; amount: number };
  rows: TailRow[];
}

/**
 * テール表: 原資産 −5 / −10 / −20 / −30 / −40% × {SQ, 指定日 + シナリオ IV}。
 * 指定日の列はシナリオの d・Δσ・Δs・β・動き方をそのまま使い、ΔX だけを各列の値に置き換える。
 */
export function tailTable(
  legs: readonly PreparedLeg[],
  scenario: Scenario,
  ctx: MarketContext,
  settings: ModelSettings = DEFAULT_SETTINGS,
  shocks: readonly number[] = TAIL_SHOCKS,
): TailTable {
  const prem = premiumSummary(legs, settings);
  const premiumBase =
    prem.net > 0
      ? { kind: 'received' as const, amount: prem.net }
      : { kind: 'paid' as const, amount: prem.net < 0 ? -prem.net + prem.fees : 0 };
  const cell = (pnl: number): TailCell => ({
    pnl,
    ratio: premiumBase.amount > 0 ? pnl / premiumBase.amount : null,
  });
  const { linear } = toLinearLegs(legs, ctx, settings);
  const rows = shocks.map((shock) => {
    const x = ctx.x0 * (1 + shock);
    const sc: Scenario = { ...scenario, dX: x - ctx.x0 };
    return {
      shock,
      x,
      sq: cell(payoffSum(linear, x)),
      scenario: cell(theoreticalPnl(legs, x, sc, ctx, settings)),
    };
  });
  return { premiumBase, rows };
}
