/**
 * 追証マップ（原資産の変化 u × IV の倍率 c の各マスの余力。#152）。設計 docs/design.md 5.11。
 *
 * - マスの状態 S = (x = X₀(1 + u), シナリオ = 今の d・Δs・IV の動き方 + ΔX = uX₀・ivShift = relative・
 *   Δσ = (c − 1) × 100・β = 0)。relative の σ = σ_base(x_eff) × c + Δs の項 なので、足の IV がちょうど c 倍になる
 *   （σ_min の下限は後）。β・Δσ を使わないのは、縦軸が IV の変化そのもので、過去の点（iv30 の実際の倍率）が原資産に
 *   対する IV の反応を含むため（β を重ねると二重に数える）
 * - マスの値 = 余力（5.10 の marginAt + marginRoom。所要額 = max(0, k × PFE − NOV)）。有限でなければ NaN
 * - 境目の線 = 格子点の余力の marching squares（辺の線形補間、鞍点は 4 隅の平均の符号）。NaN を含む区画は線にしない
 * - 点の判定 = 双線形補間の余力 < 0（線と同じ面で決める）。NaN を含む区画・範囲の外の点は数えない
 * - 計算は列（u を 1 つ固定した c の全行）ごと（holdMapColumn）。呼び出し側が 1 フレームに収まる単位で回す
 *
 * 純関数（DOM・通信・時計に依存しない）。h（保有期間の暦日）・休業日・資金は呼び出し側が決めて渡す。
 */

import { type MarginParams, marginAt, marginRoom } from './margin';
import type { MarketContext, ModelSettings, PremiumSummary, PreparedLeg } from './position';
import type { Scenario } from './scenario';

/** 横軸の既定: 原資産の変化 u（X₀ に対する比）−30%〜+20%、2% 刻み（26 列） */
export const HOLD_MAP_U = { min: -0.3, max: 0.2, step: 0.02 } as const;
/** 縦軸の既定: IV の倍率 c ×0.5〜×2.5、0.1 刻み（21 行） */
export const HOLD_MAP_C = { min: 0.5, max: 2.5, step: 0.1 } as const;
/** 点で広げるときの限界（u > −1・c > 0。これより外の点は数えない） */
export const HOLD_MAP_U_LIMIT = { min: -0.9, max: 1 } as const;
export const HOLD_MAP_C_LIMIT = { min: 0.1, max: 5 } as const;

export interface HoldMapAxes {
  /** 原資産の変化（比。昇順・等間隔） */
  us: number[];
  /** IV の倍率（昇順・等間隔） */
  cs: number[];
}

export interface HoldMapPoint {
  dx: number;
  ivRatio: number;
}

/** 刻みの値（i × step を 1e-9 に丸める。足し算で誤差を溜めない） */
const tick = (i: number, step: number) => Math.round(i * step * 1e9) / 1e9;

function axis(
  def: { min: number; max: number; step: number },
  limit: { min: number; max: number },
  values: readonly number[],
): number[] {
  const { step } = def;
  let lo = Math.round(def.min / step);
  let hi = Math.round(def.max / step);
  const loLimit = Math.ceil(limit.min / step - 1e-9);
  const hiLimit = Math.floor(limit.max / step + 1e-9);
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    const q = v / step;
    // 端ちょうどの点（浮動小数の誤差の内）は広げない
    if (q < lo - 1e-9) lo = Math.max(loLimit, Math.min(lo, Math.floor(q)));
    if (q > hi + 1e-9) hi = Math.min(hiLimit, Math.max(hi, Math.ceil(q)));
  }
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(tick(i, step));
  return out;
}

/**
 * マップの軸。既定は HOLD_MAP_U × HOLD_MAP_C（26 × 21）。点がはみ出すときだけ、同じ刻みで点を含むまで広げる
 * （限界 HOLD_MAP_U_LIMIT・HOLD_MAP_C_LIMIT の外へは広げない）。
 */
export function holdMapAxes(points: readonly HoldMapPoint[]): HoldMapAxes {
  return {
    us: axis(
      HOLD_MAP_U,
      HOLD_MAP_U_LIMIT,
      points.map((p) => p.dx),
    ),
    cs: axis(
      HOLD_MAP_C,
      HOLD_MAP_C_LIMIT,
      points.map((p) => p.ivRatio),
    ),
  };
}

/** マス (u, c) のシナリオ（d・Δs・動き方は base のまま。ΔX = uX₀・relative・Δσ = (c − 1) × 100・β = 0） */
export function holdMapScenario(base: Scenario, u: number, c: number, x0: number): Scenario {
  return { ...base, dX: u * x0, ivShift: 'relative', dSigma: (c - 1) * 100, beta: 0 };
}

/** 列の計算の入力（列ごとに同じ） */
export interface HoldMapCalc {
  legs: readonly PreparedLeg[];
  ctx: MarketContext;
  settings: ModelSettings;
  params: MarginParams;
  /** 今のシナリオ（d は clampDays 済み。d・Δs・動き方だけを使う） */
  base: Scenario;
  /** h = S の時点から 2 営業日後までの暦日 */
  horizonDays: number;
  /** 資金（円、> 0） */
  capital: number;
  premium: PremiumSummary;
}

/** 列 i（u = axes.us[i]）の各行の余力（円。長さ cs.length。有限でなければ NaN） */
export function holdMapColumn(calc: HoldMapCalc, axes: HoldMapAxes, i: number): Float64Array {
  const { legs, ctx, settings, params, base, horizonDays, capital, premium } = calc;
  const u = axes.us[i] as number;
  const x = ctx.x0 * (1 + u);
  const out = new Float64Array(axes.cs.length);
  for (let j = 0; j < axes.cs.length; j++) {
    const c = axes.cs[j] as number;
    const scenario = holdMapScenario(base, u, c, ctx.x0);
    const r = marginAt(legs, { x, scenario, horizonDays }, ctx, settings, params);
    const room = marginRoom(capital, premium, r);
    out[j] = Number.isFinite(room) ? room : Number.NaN;
  }
  return out;
}

export type HoldMapSegment = [[number, number], [number, number]];

/** 辺 a → b の上の room = 0 の点の割合（a の側 0 → b の側 1） */
const cross = (a: number, b: number) => a / (a - b);

/**
 * 境目の線（余力 = 0）の線分（(u, c) の座標）。rooms[i][j] = (us[i], cs[j]) の余力。
 * 区画ごとに marching squares（辺の線形補間）。4 辺とも符号が変わる鞍点は 4 隅の平均の符号で切る。
 * 追証の側 = 余力 < 0。NaN を含む区画は線にしない。
 */
export function holdMapContour(
  axes: HoldMapAxes,
  rooms: readonly Float64Array[],
): HoldMapSegment[] {
  const { us, cs } = axes;
  const out: HoldMapSegment[] = [];
  for (let i = 0; i + 1 < us.length; i++) {
    const colA = rooms[i];
    const colB = rooms[i + 1];
    if (!colA || !colB) continue;
    const u0 = us[i] as number;
    const u1 = us[i + 1] as number;
    for (let j = 0; j + 1 < cs.length; j++) {
      const c0 = cs[j] as number;
      const c1 = cs[j + 1] as number;
      const v00 = colA[j] as number;
      const v10 = colB[j] as number;
      const v11 = colB[j + 1] as number;
      const v01 = colA[j + 1] as number;
      if (
        !(
          Number.isFinite(v00) &&
          Number.isFinite(v10) &&
          Number.isFinite(v11) &&
          Number.isFinite(v01)
        )
      ) {
        continue;
      }
      const n00 = v00 < 0;
      const n10 = v10 < 0;
      const n11 = v11 < 0;
      const n01 = v01 < 0;
      // 辺の交点: 下（00→10）・右（10→11）・上（11→01）・左（01→00）
      const bottom: [number, number] | null =
        n00 !== n10 ? [u0 + (u1 - u0) * cross(v00, v10), c0] : null;
      const right: [number, number] | null =
        n10 !== n11 ? [u1, c0 + (c1 - c0) * cross(v10, v11)] : null;
      const top: [number, number] | null =
        n11 !== n01 ? [u1 + (u0 - u1) * cross(v11, v01), c1] : null;
      const left: [number, number] | null =
        n01 !== n00 ? [u0, c1 + (c0 - c1) * cross(v01, v00)] : null;
      const pts = [bottom, right, top, left].filter((p): p is [number, number] => p !== null);
      if (pts.length === 2) {
        out.push([pts[0] as [number, number], pts[1] as [number, number]]);
      } else if (pts.length === 4 && bottom && right && top && left) {
        // 鞍点: 00 と 11 が同じ側。中心の符号が 00 と同じなら 00–11 がつながり、10 と 01 の角を切る
        const center = (v00 + v10 + v11 + v01) / 4 < 0;
        if (center === n00) {
          out.push([bottom, right], [top, left]);
        } else {
          out.push([left, bottom], [right, top]);
        }
      }
    }
  }
  return out;
}

/** 昇順・等間隔の軸で v を含む区画の左の添字（範囲の外は −1） */
function cellIndex(xs: readonly number[], v: number): number {
  const n = xs.length;
  if (n < 2 || !Number.isFinite(v)) return -1;
  const lo = xs[0] as number;
  const hi = xs[n - 1] as number;
  if (v < lo - 1e-12 || v > hi + 1e-12) return -1;
  const step = (hi - lo) / (n - 1);
  return Math.min(n - 2, Math.max(0, Math.floor((v - lo) / step)));
}

/** (u, c) の余力の双線形補間（円）。範囲の外・NaN を含む区画は NaN */
export function holdMapRoomAt(
  axes: HoldMapAxes,
  rooms: readonly Float64Array[],
  u: number,
  c: number,
): number {
  const i = cellIndex(axes.us, u);
  const j = cellIndex(axes.cs, c);
  if (i < 0 || j < 0) return Number.NaN;
  const colA = rooms[i];
  const colB = rooms[i + 1];
  if (!colA || !colB) return Number.NaN;
  const v00 = colA[j] as number;
  const v10 = colB[j] as number;
  const v01 = colA[j + 1] as number;
  const v11 = colB[j + 1] as number;
  if (
    !(Number.isFinite(v00) && Number.isFinite(v10) && Number.isFinite(v01) && Number.isFinite(v11))
  ) {
    return Number.NaN;
  }
  const u0 = axes.us[i] as number;
  const u1 = axes.us[i + 1] as number;
  const c0 = axes.cs[j] as number;
  const c1 = axes.cs[j + 1] as number;
  const s = (u - u0) / (u1 - u0);
  const t = (c - c0) / (c1 - c0);
  return v00 * (1 - s) * (1 - t) + v10 * s * (1 - t) + v01 * (1 - s) * t + v11 * s * t;
}

export interface HoldMapCount {
  /** 数えた点の数（範囲の外・NaN の区画の点を除く） */
  n: number;
  /** そのうち追証の側（余力 < 0）の数 */
  m: number;
  /** calls[k] = 点 k が追証の側（数えない点は false） */
  calls: boolean[];
  /** counted[k] = 点 k を数えた */
  counted: boolean[];
}

/** 点（過去の 2 営業日の動き）のうち追証の側に入る数（双線形補間の余力 < 0。線と同じ面） */
export function holdMapCount(
  axes: HoldMapAxes,
  rooms: readonly Float64Array[],
  points: readonly HoldMapPoint[],
): HoldMapCount {
  let n = 0;
  let m = 0;
  const calls: boolean[] = [];
  const counted: boolean[] = [];
  for (const p of points) {
    const v = holdMapRoomAt(axes, rooms, p.dx, p.ivRatio);
    if (!Number.isFinite(v)) {
      calls.push(false);
      counted.push(false);
      continue;
    }
    n++;
    counted.push(true);
    const call = v < 0;
    if (call) m++;
    calls.push(call);
  }
  return { n, m, calls, counted };
}
